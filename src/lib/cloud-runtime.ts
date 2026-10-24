import type {Snapshot,User} from '../../shared/types';
import type {OfflineCloudState} from '../../shared/offline-cloud';
import {cloudRequest} from './cloud-sync';
import {authorizeOfflineSession,cacheCloudState,clearOfflineSession,getOfflineStatus,isCloudOfflineMutation,markCloudCommandOffline,offlineApi,offlineSession,rollbackCloudCommand,syncCloudOutbox,withCloudOfflineLock} from './cloud-offline';

export const cloudPOSUser:User={id:'cloud-owner',name:'Administrator',initials:'A',role:'owner',branchId:null};
type CloudSnapshot=Snapshot&{cloudVersion?:number;notModified?:boolean;offlineState?:OfflineCloudState};
const snapshots=new Map<string,CloudSnapshot>();
const online=()=>typeof navigator==='undefined'||navigator.onLine!==false;
const retryable=(error:unknown)=>{const status=(error as {status?:number})?.status;return !status||status>=500;};
const transport=<T>(action:string,body?:unknown)=>cloudRequest<T>(action,body,{signal:AbortSignal.timeout(8000)});
let lastTransportFailure=0;

function decorate(snapshot:Snapshot,cloudOnline:boolean,pending:number,lastError:string,lastSync:string|null):Snapshot{
  return {...snapshot,sync:{...snapshot.sync,configured:true,hubOnline:true,cloudOnline,offlineReady:true,pending,lastError:lastError||null,lastSync:lastSync??snapshot.sync.lastSync}};
}
async function localSnapshot(sourceId:string,path:string,cloudOnline=false):Promise<Snapshot>{
  const snapshot=await offlineApi<Snapshot>(sourceId,path),status=await getOfflineStatus(sourceId);
  return decorate(snapshot,cloudOnline,status.pending,status.lastError,status.lastSync);
}
async function flush(sourceId:string){
  const result=await syncCloudOutbox(sourceId,transport);
  if(result.failed&&(!result.status||result.status>=500))lastTransportFailure=Date.now();
  return result;
}
/** Caller holds the per-shop lock across upload and cache replacement. */
async function bootstrapCloud(sourceId:string,url:URL):Promise<Snapshot>{
  if(!online())return localSnapshot(sourceId,url.pathname+url.search);
  const state=await getOfflineStatus(sourceId);
  if(state.pending){
    const result=await flush(sourceId);
    if(result.pending){
      if(result.status===401||result.status===403)throw Object.assign(new Error('Enter your staff PIN to upload your saved bills.'),{status:401});
      return localSnapshot(sourceId,url.pathname+url.search,Boolean(result.status&&result.status<500));
    }
  }
  const key=`${sourceId}:${url.searchParams.get('branchId')??''}`,cached=snapshots.get(key);
  try{
    const query=new URLSearchParams(url.searchParams);query.set('sourceId',sourceId);query.set('includeOffline','1');
    if(cached&&state.ready)query.set('ifVersion',String(cached.cloudVersion??0));
    const result=await transport<CloudSnapshot>(`bootstrap&${query}`);
    lastTransportFailure=0;
    if(result.notModified&&cached){
      const status=await getOfflineStatus(sourceId);
      return decorate({...cached,serverTime:result.serverTime},true,status.pending,status.lastError,status.lastSync);
    }
    if(!result.offlineState)throw Object.assign(new Error('Reload the updated website to prepare offline billing.'),{status:503});
    const applied=await cacheCloudState(sourceId,result.offlineState,result.user??cloudPOSUser);
    const {offlineState:_,...snapshot}=result;
    snapshots.set(key,snapshot);
    if(!applied&&(await getOfflineStatus(sourceId)).pending)return localSnapshot(sourceId,url.pathname+url.search,true);
    const status=await getOfflineStatus(sourceId);
    return decorate(snapshot,true,status.pending,status.lastError,status.lastSync);
  }catch(error){
    if(!retryable(error))throw error;
    lastTransportFailure=Date.now();
    if(state.ready)return localSnapshot(sourceId,url.pathname+url.search);
    throw error;
  }
}

export async function cloudRuntimeApi<T>(sourceId:string,path:string,body?:unknown,inputMethod?:string):Promise<T>{
  const url=new URL(path.replace(/^\/api(?=\/)/,''),'https://workspace');
  const method=(inputMethod??(body===undefined?'GET':'POST')).toUpperCase();
  if(url.pathname==='/session'){
    if(!online())return {user:await offlineSession(sourceId),demo:false} as T;
    try{
      const result=await transport<{authenticated:boolean}>('pos-session');
      if(result.authenticated)await authorizeOfflineSession(sourceId,cloudPOSUser);
      else await clearOfflineSession(sourceId);
      return {user:result.authenticated?cloudPOSUser:null,demo:false} as T;
    }catch(error){if(retryable(error))return {user:await offlineSession(sourceId),demo:false} as T;throw error;}
  }
  if(url.pathname==='/login'){
    await transport('pos-login',body);await authorizeOfflineSession(sourceId,cloudPOSUser);
    return {user:cloudPOSUser,demo:false} as T;
  }
  if(url.pathname==='/logout'){
    if(online())await transport('pos-logout',{});
    await clearOfflineSession(sourceId);
    snapshots.clear();location.href='/';return {ok:true} as T;
  }
  if(url.pathname==='/bootstrap')return withCloudOfflineLock(sourceId,()=>bootstrapCloud(sourceId,url)) as Promise<T>;
  if(method!=='GET'&&isCloudOfflineMutation(url.pathname,method)){
    return withCloudOfflineLock(sourceId,async()=>{
      if(!(await getOfflineStatus(sourceId)).ready)await bootstrapCloud(sourceId,new URL('/bootstrap','https://workspace'));
      let connected=online()&&Date.now()-lastTransportFailure>3000;
      if(connected&&(await getOfflineStatus(sourceId)).pending){
        const previous=await flush(sourceId);
        if(previous.status===401||previous.status===403)throw Object.assign(new Error('Enter your staff PIN to sync your saved bills.'),{status:401});
        if(previous.pending)connected=false;
      }
      const payload={...body as object,commandId:(body as {commandId?:string})?.commandId??`command-${crypto.randomUUID()}`};
      const result=await offlineApi<T>(sourceId,url.pathname+url.search,payload,method,{offline:!connected});
      if(!connected)return result;
      let uploaded=await flush(sourceId);
      if(uploaded.code==='CLOUD_BUSY')uploaded=await flush(sourceId);
      if(uploaded.pending&&uploaded.transactionId===payload.commandId){
        if(uploaded.status&&uploaded.status<500&&uploaded.code!=='CLOUD_BUSY'){
          const restored=await rollbackCloudCommand(sourceId,payload.commandId);
          throw Object.assign(new Error(restored?uploaded.lastError:`This saved action needs review: ${uploaded.lastError}`),{status:uploaded.status,code:uploaded.code});
        }
        await markCloudCommandOffline(sourceId,payload.commandId);
      }
      return result;
    });
  }
  if(!online())return offlineApi<T>(sourceId,url.pathname+url.search,body,method);
  // Product/configuration writes stay online. They must not overtake saved sales.
  return withCloudOfflineLock(sourceId,async()=>{
    if((await getOfflineStatus(sourceId)).pending){
      const pending=await flush(sourceId);
      if(pending.pending){
        if(method==='GET')return offlineApi<T>(sourceId,url.pathname+url.search,body,method);
        throw Object.assign(new Error('Your saved bills are still uploading. Retry this change after sync completes.'),{status:503});
      }
    }
    try{return await transport<T>('command',{sourceId,path:url.pathname+url.search,method,...(body===undefined?{}:{body:{...body as object,...(method==='GET'?{}:{commandId:(body as {commandId?:string})?.commandId??`command-${crypto.randomUUID()}`})}})});}
    catch(error){if(method==='GET'&&retryable(error))return offlineApi<T>(sourceId,url.pathname+url.search,body,method);throw error;}
  });
}
