import {CLOUD_MONITOR_KINDS,type CloudChange,type CloudEnrollmentResult} from '../../shared/cloud-monitor';
import {localDb,type LocalDatabase,type LocalChange} from './local/db';
import {getLocalUser} from './local/auth';
import {getLocalWorkspaceInfo} from './local/seed';

const key='cloudMonitor:connection',leaseKey='cloudMonitor:lease';
const kinds=new Set<string>(CLOUD_MONITOR_KINDS);
interface Connection {
  sourceId:string;epoch:string;token:string;deviceName:string;businessName:string;
  sequence:number;cursor:number;baseline:{chunks:CloudChange[][];index:number;cursor:number}|null;
  lastUploadedAt:string|null;lastSeenAt:string|null;lastError:string;needsReconnect:boolean;shared?:boolean;
}
export interface CloudSyncState {
  linked:boolean;sourceId:string;deviceName:string;businessName:string;pending:number;
  lastUploadedAt:string|null;lastSeenAt:string|null;lastError:string;needsReconnect:boolean;shared?:boolean;
}
interface Options {db?:LocalDatabase;fetch?:typeof fetch}
let lastCloudContact=0;
export const getLastCloudContact=()=>lastCloudContact;
const changed=()=>{if(typeof window!=='undefined')window.dispatchEvent(new Event('cloud-monitor-change'));};
let activeRequests=new AbortController();
let signedOut=false;
/** A late session/refresh response must not restore a cookie after Sign out. */
export function endCloudSession(){signedOut=true;activeRequests.abort();activeRequests=new AbortController();}
export async function cloudRequest<T>(action:string,body?:unknown,options:RequestInit={}):Promise<T>{
  const operation=action.split('&')[0];
  if(signedOut&&!['status','pos-login','login','pos-logout','logout'].includes(operation))throw Object.assign(new Error('Enter your staff PIN to open this workspace.'),{status:401,code:'UNAUTHENTICATED'});
  let response:Response;
  try{response=await fetch(`/api/cloud?action=${action}`,{credentials:'same-origin',...options,method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...options.headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([options.signal??AbortSignal.timeout(20000),activeRequests.signal])});}catch(error){if(typeof window!=='undefined')window.dispatchEvent(new Event('cloud-failure'));throw error;}
  const result=await response.json().catch(()=>({error:'The cloud service returned an invalid response.'}));
  if(!response.ok){lastCloudContact=0;if(typeof window!=='undefined')window.dispatchEvent(new Event('cloud-failure'));throw Object.assign(new Error(result.error??'Cloud request failed.'),{status:response.status,code:result.code});}if(['pos-login','login'].includes(operation))signedOut=false;lastCloudContact=Date.now();if(typeof window!=='undefined')window.dispatchEvent(new Event('cloud-contact'));return result as T;
}
function sanitize(value:unknown):unknown {
  if(Array.isArray(value))return value.map(sanitize);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([name])=>!['pin','password','salt','hash','token','private_key','__proto__','constructor','prototype'].includes(name.toLowerCase())).map(([name,item])=>[name,name==='image'&&typeof item==='string'&&item.startsWith('/api/media/')?'':sanitize(item)]));
  return value;
}
export function monitoringChanges(rows:LocalChange[]):CloudChange[]{return rows.filter(row=>row.kind!=='media'&&kinds.has(row.kind)).map(row=>({...row,kind:row.kind as CloudChange['kind'],value:sanitize(row.value) as Record<string,unknown>}));}
export function cloudChunks(rows:CloudChange[],limit=550000):CloudChange[][] {
  const chunks:CloudChange[][]=[];let current:CloudChange[]=[],size=2;
  for(const row of rows){const bytes=new TextEncoder().encode(JSON.stringify(row)).length+1;
    if(bytes>limit)throw new Error('A business record exceeds the cloud packet limit. Keep the local backup and contact support.');
    if(current.length>=100||size+bytes>limit){chunks.push(current);current=[];size=2;}
    current.push(row);size+=bytes;
  }
  if(current.length||!chunks.length)chunks.push(current);return chunks;
}
export async function getCloudSyncState(db:LocalDatabase=localDb):Promise<CloudSyncState|null>{
  const value=(await db.metadata.get(key))?.value as Connection|undefined;if(!value)return null;
  const journalSequence=Number((await db.metadata.get('journalSequence'))?.value??0);
  const {token:_,epoch:__,baseline,...publicState}=value;
  return {...publicState,linked:true,pending:(baseline?baseline.chunks.length-baseline.index:0)+Math.max(0,journalSequence-(baseline?.cursor??value.cursor))};
}
async function ownerSessionPair(deviceName:string,options:Options={},replaceObsolete=false,posAuthorized=false):Promise<CloudSyncState>{
  const db=options.db??localDb,request=options.fetch??fetch;
  if(!posAuthorized&&(await getLocalUser(db))?.role!=='owner')throw new Error('Sign in to your POS before transferring saved local records.');
  if(!replaceObsolete&&await db.metadata.get(key))throw new Error('Disconnect the existing cloud connection first.');
  const info=await getLocalWorkspaceInfo(db);if(!info)throw new Error('Set up this device first.');
  const sourceId=`source-${crypto.randomUUID()}`;
  const enrolled=await cloudRequestWith(request,'enroll',{sourceId,workspaceId:info.workspaceId,businessName:info.businessName,deviceName}) as CloudEnrollmentResult;
  const baseline=await db.transaction('r',db.records,db.metadata,async()=>{
    const rows=(await db.records.toArray()).map(({kind,id,branchId,value})=>({kind,id,branchId,value}));
    rows.push({kind:'settings',id:'settings',branchId:null,value:(await db.metadata.get('settings'))?.value});
    return {chunks:cloudChunks(monitoringChanges(rows)),index:0,cursor:Number((await db.metadata.get('journalSequence'))?.value??0)};
  });
  const connection:Connection={...enrolled,deviceName,businessName:info.businessName,baseline,sequence:0,cursor:0,lastUploadedAt:null,lastSeenAt:null,lastError:'',needsReconnect:false};
  await db.metadata.put({key,value:connection});changed();return (await getCloudSyncState(db))!;
}
async function cloudRequestWith(request:typeof fetch,action:string,body?:unknown):Promise<unknown>{
  const response=await request(`/api/cloud?action=${action}`,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const value=await response.json();
  if(!response.ok)throw Object.assign(new Error(value.error??'Cloud connection failed.'),{status:response.status,code:value.code});
  return value;
}
export async function connectDeviceToCloud(input:{email:string;password:string;deviceName:string},options:Options={}):Promise<CloudSyncState>{
  const db=options.db??localDb;
  if((await getLocalUser(db))?.role!=='owner')throw new Error('Only the device owner can connect cloud monitoring.');
  if(await db.metadata.get(key))throw new Error('Disconnect the existing cloud connection first.');
  await cloudRequestWith(options.fetch??fetch,'login',{email:input.email,password:input.password});
  return ownerSessionPair(input.deviceName,options);
}
/** Automatic connection is authorized by the cloud owner session, never an
 * anonymous write grant. Existing cloud data always takes precedence; local
 * records are imported only when the server confirms no business exists yet. */
export async function openAutomaticCloudWorkspace(options:Options={}):Promise<string|null>{
  const db=options.db??localDb,request=options.fetch??fetch;
  type Result={sourceId:string|null;empty?:boolean;selectionRequired?:boolean};
  // A single server-verified POS login authorizes both the shared workspace and
  // this device's first import. An expired local PIN session needs no second login.
  const session=await cloudRequestWith(request,'pos-session') as {authenticated:boolean};
  if(!session.authenticated)throw Object.assign(new Error('Sign in with your staff PIN.'),{status:401});
  // Finish this device's already-authorized journal before a monitoring-only
  // source changes to shared authority. Promotion must not strand its last sales.
  let before=await getCloudSyncState(db);
  if(before&&!before.shared){
    const connection=(await db.metadata.get(key))!.value as Connection;
    const info=await getLocalWorkspaceInfo(db);
    if(info){
      try{
        const renewed=await cloudRequestWith(request,'refresh-device',{sourceId:connection.sourceId,workspaceId:info.workspaceId}) as CloudEnrollmentResult;
        await db.metadata.put({key,value:{...connection,...renewed,needsReconnect:false,lastError:''}});
        before=await getCloudSyncState(db);
      }catch(error){
        if((error as {code?:string}).code!=='SHARED_WORKSPACE')throw error;
        await db.metadata.put({key,value:{...connection,shared:true,needsReconnect:false,lastError:''}});
        before=await getCloudSyncState(db);
      }
    }
  }
  if(before&&!before.shared&&!before.needsReconnect&&before.pending){
    const uploaded=await syncDeviceCloud(options);
    if(uploaded?.lastError&&!uploaded.shared)throw new Error(uploaded.lastError);
    if(uploaded?.pending&&!uploaded.shared)throw new Error('The original device upload is still in progress. Keep this app open and retry.');
  }
  let result=await cloudRequestWith(request,'workspace',{create:false}) as Result;
  if(result.sourceId)return result.sourceId;
  if(result.selectionRequired){
    const pending=await getCloudSyncState(db);
    if(pending&&!pending.shared&&!pending.needsReconnect&&pending.pending){
      const synced=await syncDeviceCloud(options);
      if(synced?.lastError)throw new Error(synced.lastError);
      result=await cloudRequestWith(request,'workspace',{create:false}) as Result;
    }
    if(result.sourceId||result.selectionRequired)return result.sourceId;
  }
  const info=await getLocalWorkspaceInfo(db);
  if(result.empty&&info){
    let state=await getCloudSyncState(db);
    if(!state||state.needsReconnect||state.shared)state=await ownerSessionPair('Original shop device',options,true,true);
    state=await syncDeviceCloud(options);
    if(state?.needsReconnect){await ownerSessionPair('Original shop device',options,true,true);state=await syncDeviceCloud(options);}
    if(!state||state.lastError||state.pending)throw new Error(state?.lastError||'The original device upload is still in progress. Keep this app open and retry.');
    result=await cloudRequestWith(request,'workspace',{create:false}) as Result;
  }else if(result.empty){result=await cloudRequestWith(request,'workspace',{create:true}) as Result;}
  return result.sourceId;
}
export async function disconnectDeviceCloud(options:Options={}){
  const db=options.db??localDb;if((await getLocalUser(db))?.role!=='owner')throw new Error('Only the owner can disconnect this device.');
  await db.metadata.delete(key);changed();
}
export async function syncDeviceCloud(options:Options={}):Promise<CloudSyncState|null>{
  const db=options.db??localDb,request=options.fetch??fetch;
  // An unpaired device never receives a write grant from a background sync.
  if(!await db.metadata.get(key))return null;
  const lease=crypto.randomUUID();let acquired=false;
  await db.transaction('rw',db.metadata,async()=>{
    const current=(await db.metadata.get(leaseKey))?.value as {id:string;expires:number}|undefined;
    if(current&&current.expires>Date.now())return;
    await db.metadata.put({key:leaseKey,value:{id:lease,expires:Date.now()+30000}});acquired=true;
  });
  if(!acquired)return getCloudSyncState(db);
  let connection:Connection|undefined;
  const save=async()=>db.transaction('rw',db.metadata,async()=>{
    if(((await db.metadata.get(leaseKey))?.value as {id?:string})?.id!==lease)throw new Error('Another tab is uploading. Retry after it finishes.');
    const current=(await db.metadata.get(key))?.value as Connection|undefined;
    if(current?.sourceId!==connection!.sourceId)throw new Error('Cloud connection changed.');
    await db.metadata.put({key,value:connection});await db.metadata.put({key:leaseKey,value:{id:lease,expires:Date.now()+30000}});
  });
  try{
    connection=(await db.metadata.get(key))?.value as Connection|undefined;
    if(!connection||connection.needsReconnect||connection.shared)return getCloudSyncState(db);
    const send=async<T>(action:string,body:unknown):Promise<T>=>{
      const response=await request(`/api/cloud?action=${action}`,{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json',Authorization:`Bearer ${connection!.token}`},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
      const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error??'Cloud upload failed.'),{status:response.status,code:value.code});return value;
    };
    let uploads=0;
    for(;uploads<50;uploads++){
      const baseline=connection.baseline;
      const journal=baseline?null:await db.journal.where('sequence').above(connection.cursor).sortBy('sequence').then(rows=>rows[0]??null);
      if(!baseline&&!journal)break;
      const changes=baseline?baseline.chunks[baseline.index]:monitoringChanges(journal!.changes);
      if(new TextEncoder().encode(JSON.stringify(changes)).length>600000)throw new Error('A transaction is too large for cloud sync. Keep the local backup and contact support.');
      const result=await send<{sequence:number;updatedAt:string}>('push',{sourceId:connection.sourceId,epoch:connection.epoch,sequence:connection.sequence+1,eventId:baseline?`baseline-${connection.epoch}-${baseline.index}`:`journal-${journal!.sequence}`,ready:!baseline||baseline.index===baseline.chunks.length-1,changes});
      if(result.sequence!==connection.sequence+1)throw new Error('Cloud acknowledgement did not match the uploaded packet. Keep this device open and retry.');
      connection.sequence=result.sequence;connection.lastUploadedAt=result.updatedAt;connection.lastSeenAt=result.updatedAt;connection.lastError='';
      if(baseline){baseline.index++;if(baseline.index>=baseline.chunks.length){connection.cursor=baseline.cursor;connection.baseline=null;}}
      else connection.cursor=journal!.sequence;
      await save();changed();
    }
    if(uploads===0){
      const response=await send<{lastSeenAt:string;shared?:boolean}>('heartbeat',{sourceId:connection.sourceId,epoch:connection.epoch});
      connection.lastSeenAt=response.lastSeenAt;
      if(response.shared)connection.shared=true;
      connection.lastError='';
      await save();
    }

  }catch(error){
    if(connection){const value=error as Error&{status?:number;code?:string};connection.lastError=value.message;
      if(value.status===401||value.status===403)connection.needsReconnect=true;
      if(value.code==='SHARED_WORKSPACE')connection.shared=true;
      await save().catch(()=>{});changed();
    }
  }finally{
    await db.transaction('rw',db.metadata,async()=>{if(((await db.metadata.get(leaseKey))?.value as {id?:string})?.id===lease)await db.metadata.delete(leaseKey);}).catch(()=>{});
  }
  return getCloudSyncState(db);
}

