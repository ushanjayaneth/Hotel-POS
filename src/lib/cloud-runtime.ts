import type {Snapshot,User} from '../../shared/types';
import type {OfflineCloudState} from '../../shared/offline-cloud';
import {cloudRequest,endCloudSession} from './cloud-sync';
import {authorizeOfflinePIN,authorizeOfflineSession,cacheCloudState,clearOfflineSession,getOfflineStatus,isCloudOfflineMutation,markCloudCommandOffline,offlineApi,offlineSession,offlineSignIn,rollbackCloudCommand,syncCloudOutbox,withCloudOfflineLock} from './cloud-offline';

export const cloudPOSUser:User={id:'cloud-owner',name:'Administrator',initials:'A',role:'owner',branchId:null};
type CloudSnapshot=Snapshot&{cloudVersion?:number;notModified?:boolean;offlineState?:OfflineCloudState};
const snapshots=new Map<string,CloudSnapshot>();
const online=()=>typeof navigator==='undefined'||navigator.onLine!==false;
const retryable=(error:unknown)=>{const status=(error as {status?:number})?.status;return !status||status>=500;};
const failures=new Map<string,{count:number;retryAt:number}>();
const coolingDown=(sourceId:string)=>(failures.get(sourceId)?.retryAt??0)>Date.now();
export const retryCloudConnection=(sourceId:string)=>{failures.delete(sourceId);};
function failedConnection(sourceId:string){
  const count=Math.min(3,(failures.get(sourceId)?.count??0)+1);
  failures.set(sourceId,{count,retryAt:Date.now()+Math.min(60000,15000*2**(count-1))});
}
async function transport<T>(sourceId:string,action:string,body?:unknown,timeout=8000):Promise<T>{
  try{
    const result=await cloudRequest<T>(action,body,{signal:AbortSignal.timeout(timeout)});
    failures.delete(sourceId);return result;
  }catch(error){if(retryable(error))failedConnection(sourceId);throw error;}
}

function decorate(snapshot:Snapshot,cloudOnline:boolean,pending:number,lastError:string,lastSync:string|null):Snapshot{
  return {...snapshot,sync:{...snapshot.sync,configured:true,hubOnline:true,cloudOnline,offlineReady:true,pending,lastError:lastError||null,lastSync:lastSync??snapshot.sync.lastSync}};
}
async function localSnapshot(sourceId:string,path:string,cloudOnline=false):Promise<Snapshot>{
  const snapshot=await offlineApi<Snapshot>(sourceId,path),status=await getOfflineStatus(sourceId);
  return decorate(snapshot,cloudOnline,status.pending,status.lastError,status.lastSync);
}
async function flush(sourceId:string,background=false){
  return syncCloudOutbox(sourceId,<T>(action:string,body?:unknown)=>transport<T>(sourceId,action,body,background?2000:8000));
}
/** Caller holds the per-shop lock across upload and cache replacement. */
async function bootstrapCloud(sourceId:string,url:URL):Promise<Snapshot>{
  if(!online())return localSnapshot(sourceId,url.pathname+url.search);
  const state=await getOfflineStatus(sourceId);
  if(state.ready&&coolingDown(sourceId))return localSnapshot(sourceId,url.pathname+url.search);
  if(state.pending){
    const result=await flush(sourceId,true);
    if(result.pending){
      if(result.status===401||result.status===403)throw Object.assign(new Error('Enter your staff PIN to upload your saved bills.'),{status:401});
      return localSnapshot(sourceId,url.pathname+url.search,Boolean(result.status&&result.status<500));
    }
  }
  const key=`${sourceId}:${url.searchParams.get('branchId')??''}`,cached=snapshots.get(key);
  try{
    const query=new URLSearchParams(url.searchParams);query.set('sourceId',sourceId);query.set('includeOffline','1');
    if(cached&&state.ready)query.set('ifVersion',String(cached.cloudVersion??0));
    const result=await transport<CloudSnapshot>(sourceId,`bootstrap&${query}`,undefined,state.ready?2000:8000);
    if(result.notModified&&cached){
      const status=await getOfflineStatus(sourceId);
      return decorate({...cached,serverTime:result.serverTime},true,status.pending,status.lastError,status.lastSync);
    }
    if(!result.offlineState)throw Object.assign(new Error('Reload the updated website to prepare offline billing.'),{status:503});
    const applied=await cacheCloudState(sourceId,result.offlineState,result.user??cloudPOSUser);
    if(!applied){
      // Another tab may already have newer records, even with no queued writes.
      // Keep that replica visible and request a complete snapshot next time.
      snapshots.delete(key);
      return localSnapshot(sourceId,url.pathname+url.search,true);
    }
    const {offlineState:_,...snapshot}=result;
    snapshots.set(key,snapshot);
    const status=await getOfflineStatus(sourceId);
    return decorate(snapshot,true,status.pending,status.lastError,status.lastSync);
  }catch(error){
    if(!retryable(error))throw error;
    if(state.ready)return localSnapshot(sourceId,url.pathname+url.search);
    throw error;
  }
}

export async function cloudRuntimeApi<T>(sourceId:string,path:string,body?:unknown,inputMethod?:string):Promise<T>{
  const url=new URL(path.replace(/^\/api(?=\/)/,''),'https://workspace');
  const method=(inputMethod??(body===undefined?'GET':'POST')).toUpperCase();
  if(url.pathname==='/session'){
    try{if(localStorage.getItem(`dh-cloud-lock:${sourceId}`)==='1')return {user:null,demo:false} as T;}catch{/* Optional preference storage. */}
    if(!online()||coolingDown(sourceId))return {user:await offlineSession(sourceId),demo:false} as T;
    try{
      const result=await transport<{authenticated:boolean}>(sourceId,'pos-session',undefined,2000);
      if(result.authenticated)await authorizeOfflineSession(sourceId,cloudPOSUser);
      else await clearOfflineSession(sourceId);
      return {user:result.authenticated?cloudPOSUser:null,demo:false} as T;
    }catch(error){if(retryable(error))return {user:await offlineSession(sourceId),demo:false} as T;throw error;}
  }
  if(url.pathname==='/login'){
    const pin=String((body as {pin?:string})?.pin??'');
    if(!online()){
      const user=await offlineSignIn(sourceId,pin);
      try{localStorage.removeItem(`dh-cloud-lock:${sourceId}`);}catch{/* Optional preference storage. */}
      return {user,demo:false} as T;
    }
    await transport(sourceId,'pos-login',body);await authorizeOfflinePIN(sourceId,pin,cloudPOSUser);
    try{localStorage.removeItem(`dh-cloud-lock:${sourceId}`);}catch{/* Optional preference storage. */}
    return {user:cloudPOSUser,demo:false} as T;
  }
  if(url.pathname==='/logout'){
    try{localStorage.setItem(`dh-cloud-lock:${sourceId}`,'1');}catch{/* Cached authorization is still cleared. */}
    endCloudSession();await clearOfflineSession(sourceId);
    if(online())try{await transport(sourceId,'pos-logout',{},2000);}catch(error){if(!retryable(error))throw error;}
    snapshots.clear();location.href='/';return {ok:true} as T;
  }
  if(url.pathname==='/bootstrap')return withCloudOfflineLock(sourceId,()=>bootstrapCloud(sourceId,url)) as Promise<T>;
  if(method!=='GET'&&isCloudOfflineMutation(url.pathname,method)){
    return withCloudOfflineLock(sourceId,async()=>{
      if(!(await getOfflineStatus(sourceId)).ready)await bootstrapCloud(sourceId,new URL('/bootstrap','https://workspace'));
      let connected=online()&&!coolingDown(sourceId);
      if(connected&&(await getOfflineStatus(sourceId)).pending){
        const previous=await flush(sourceId,true);
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
  if(!online()||coolingDown(sourceId))return offlineApi<T>(sourceId,url.pathname+url.search,body,method);
  // Remaining server-only operations must not overtake queued local writes.
  return withCloudOfflineLock(sourceId,async()=>{
    if((await getOfflineStatus(sourceId)).pending){
      const pending=await flush(sourceId,true);
      if(pending.pending){
        if(method==='GET')return offlineApi<T>(sourceId,url.pathname+url.search,body,method);
        throw Object.assign(new Error('Your saved bills are still uploading. Retry this change after sync completes.'),{status:503});
      }
    }
    try{return await transport<T>(sourceId,'command',{sourceId,path:url.pathname+url.search,method,...(body===undefined?{}:{body:{...body as object,...(method==='GET'?{}:{commandId:(body as {commandId?:string})?.commandId??`command-${crypto.randomUUID()}`})}})});}
    catch(error){if(method==='GET'&&retryable(error))return offlineApi<T>(sourceId,url.pathname+url.search,body,method);throw error;}
  });
}
