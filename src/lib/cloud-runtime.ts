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
const connectedSources=new Set<string>();
const refreshes=new Map<string,Promise<void>>();
const refreshedAt=new Map<string,number>();
const sessionChecks=new Map<string,Promise<{user:User|null;demo:false}>>();
const sessionCheckedAt=new Map<string,number>();
const coolingDown=(sourceId:string)=>(failures.get(sourceId)?.retryAt??0)>Date.now();
export const retryCloudConnection=(sourceId:string)=>{
  failures.delete(sourceId);sessionCheckedAt.delete(sourceId);
  for(const key of refreshedAt.keys())if(key.startsWith(`${sourceId}:`))refreshedAt.delete(key);
};
function announce(type:string,sourceId:string,detail:Record<string,unknown>={}){
  if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent(type,{detail:{sourceId,...detail}}));
}
function locked(sourceId:string){
  try{return localStorage.getItem(`dh-cloud-lock:${sourceId}`)==='1';}catch{return false;}
}
function failedConnection(sourceId:string){
  connectedSources.delete(sourceId);
  const count=Math.min(3,(failures.get(sourceId)?.count??0)+1);
  failures.set(sourceId,{count,retryAt:Date.now()+Math.min(60000,15000*2**(count-1))});
}
async function transport<T>(sourceId:string,action:string,body?:unknown,timeout=8000):Promise<T>{
  try{
    const result=await cloudRequest<T>(action,body,{signal:AbortSignal.timeout(timeout)});
    failures.delete(sourceId);connectedSources.add(sourceId);return result;
  }catch(error){if(retryable(error))failedConnection(sourceId);throw error;}
}

function decorate(snapshot:Snapshot,cloudOnline:boolean,pending:number,lastError:string,lastSync:string|null):Snapshot{
  return {...snapshot,sync:{...snapshot.sync,configured:true,hubOnline:true,cloudOnline,offlineReady:true,pending,lastError:lastError||null,lastSync:lastSync??snapshot.sync.lastSync}};
}
async function localSnapshot(sourceId:string,path:string,cloudOnline=online()&&!coolingDown(sourceId)&&connectedSources.has(sourceId)):Promise<Snapshot>{
  const snapshot=await offlineApi<Snapshot>(sourceId,path),status=await getOfflineStatus(sourceId);
  return decorate(snapshot,cloudOnline,status.pending,status.lastError,status.lastSync);
}
async function flush(sourceId:string,background=false){
  return syncCloudOutbox(sourceId,<T>(action:string,body?:unknown)=>transport<T>(sourceId,action,body,background?2000:8000));
}
/** Network reads do not hold the cashier lock. Cache replacement itself checks
 * pending writes and newer cloud versions in one IndexedDB transaction. */
async function bootstrapCloud(sourceId:string,url:URL):Promise<Snapshot>{
  if(!online())return localSnapshot(sourceId,url.pathname+url.search);
  const state=await getOfflineStatus(sourceId);
  if(state.ready&&coolingDown(sourceId))return localSnapshot(sourceId,url.pathname+url.search);
  if(state.pending){
    const result=await withCloudOfflineLock(sourceId,()=>flush(sourceId,true));
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
    if(locked(sourceId))throw Object.assign(new Error('Enter your staff PIN to open this workspace.'),{status:401});
    if(result.notModified&&cached){
      const status=await getOfflineStatus(sourceId);
      return decorate(await offlineApi<Snapshot>(sourceId,url.pathname+url.search),true,status.pending,status.lastError,status.lastSync);
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

async function clearRejectedSession(sourceId:string){
  connectedSources.delete(sourceId);
  // A concurrent successful read must not silently reopen a rejected session.
  try{localStorage.setItem(`dh-cloud-lock:${sourceId}`,'1');}catch{/* Cached authorization is cleared below. */}
  await clearOfflineSession(sourceId);
  announce('cloud-runtime-session',sourceId,{user:null});
}

/** Prepared workspaces render their verified local records first. One cloud
 * refresh per branch runs in the background; its notification reads the cache
 * again without immediately starting another request. */
function refreshInBackground(sourceId:string,url:URL){
  if(!online()||coolingDown(sourceId)||locked(sourceId))return;
  const branchId=url.searchParams.get('branchId')??'',key=`${sourceId}:${branchId}`;
  if(refreshes.has(key)||Date.now()-(refreshedAt.get(key)??0)<4500)return;
  refreshedAt.set(key,Date.now());
  const pending=bootstrapCloud(sourceId,url).then(()=>{
    announce('cloud-runtime-refresh',sourceId,{branchId});
  }).catch(async error=>{
    if([401,403].includes((error as {status?:number}).status??0))await clearRejectedSession(sourceId);
    else announce('cloud-runtime-refresh',sourceId,{branchId});
  }).finally(()=>{refreshes.delete(key);});
  refreshes.set(key,pending);
}

function verifySession(sourceId:string):Promise<{user:User|null;demo:false}>{
  const current=sessionChecks.get(sourceId);if(current)return current;
  sessionCheckedAt.set(sourceId,Date.now());
  const pending=(async()=>{
    try{
      const result=await transport<{authenticated:boolean}>(sourceId,'pos-session',undefined,2000);
      // Sign out may occur while a response or its JSON body is being read.
      if(locked(sourceId))return {user:null,demo:false as const};
      if(result.authenticated){await authorizeOfflineSession(sourceId,cloudPOSUser);return {user:cloudPOSUser,demo:false as const};}
      await clearRejectedSession(sourceId);return {user:null,demo:false as const};
    }catch(error){
      if(retryable(error))return {user:await offlineSession(sourceId),demo:false as const};
      if([401,403].includes((error as {status?:number}).status??0))await clearRejectedSession(sourceId);
      throw error;
    }
  })().finally(()=>{sessionChecks.delete(sourceId);});
  sessionChecks.set(sourceId,pending);return pending;
}

export async function cloudRuntimeApi<T>(sourceId:string,path:string,body?:unknown,inputMethod?:string):Promise<T>{
  const url=new URL(path.replace(/^\/api(?=\/)/,''),'https://workspace');
  const method=(inputMethod??(body===undefined?'GET':'POST')).toUpperCase();
  if(url.pathname==='/session'){
    if(locked(sourceId))return {user:null,demo:false} as T;
    const user=await offlineSession(sourceId);
    if(!online()||coolingDown(sourceId))return {user,demo:false} as T;
    if(user){
      if(Date.now()-(sessionCheckedAt.get(sourceId)??0)>=4500)void verifySession(sourceId).catch(()=>{});
      return {user,demo:false} as T;
    }
    return verifySession(sourceId) as Promise<T>;
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
    snapshots.clear();connectedSources.delete(sourceId);sessionCheckedAt.delete(sourceId);location.href='/';return {ok:true} as T;
  }
  if(url.pathname==='/bootstrap'){
    if((await getOfflineStatus(sourceId)).ready){
      const snapshot=await localSnapshot(sourceId,url.pathname+url.search);
      refreshInBackground(sourceId,url);return snapshot as T;
    }
    return bootstrapCloud(sourceId,url) as Promise<T>;
  }
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
  // Ledgers, reports, receipts and cached media already have authorized local
  // handlers. Only an explicitly unsupported read should wait for the server.
  if(method==='GET'){
    try{return await offlineApi<T>(sourceId,url.pathname+url.search,body,method);}
    catch(error){if((error as {code?:string}).code!=='ONLINE_REQUIRED')throw error;}
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
