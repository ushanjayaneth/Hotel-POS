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
const changed=()=>{if(typeof window!=='undefined')window.dispatchEvent(new Event('cloud-monitor-change'));};
export async function cloudRequest<T>(action:string,body?:unknown,options:RequestInit={}):Promise<T>{
  let response:Response;
  try{response=await fetch(`/api/cloud?action=${action}`,{credentials:'same-origin',...options,method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...options.headers},body:body===undefined?undefined:JSON.stringify(body),signal:options.signal??AbortSignal.timeout(20000)});}catch(error){if(typeof window!=='undefined')window.dispatchEvent(new Event('cloud-failure'));throw error;}
  const result=await response.json().catch(()=>({error:'The cloud service returned an invalid response.'}));
  if(!response.ok){if(typeof window!=='undefined')window.dispatchEvent(new Event('cloud-failure'));throw Object.assign(new Error(result.error??'Cloud request failed.'),{status:response.status,code:result.code});}if(typeof window!=='undefined')window.dispatchEvent(new Event('cloud-contact'));return result as T;
}
function sanitize(value:unknown):unknown {
  if(Array.isArray(value))return value.map(sanitize);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([name])=>!['pin','password','salt','hash','token','private_key','__proto__','constructor','prototype'].includes(name.toLowerCase())).map(([name,item])=>[name,name==='image'&&typeof item==='string'&&item.startsWith('/api/media/')?'':sanitize(item)]));
  return value;
}
export function monitoringChanges(rows:LocalChange[]):CloudChange[]{return rows.filter(row=>kinds.has(row.kind)).map(row=>({...row,kind:row.kind as CloudChange['kind'],value:sanitize(row.value) as Record<string,unknown>}));}
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
export async function connectDeviceToCloud(input:{email:string;password:string;deviceName:string},options:Options={}):Promise<CloudSyncState>{
  const db=options.db??localDb,request=options.fetch??fetch;
  if((await getLocalUser(db))?.role!=='owner')throw new Error('Only the device owner can connect cloud monitoring.');
  if(await db.metadata.get(key))throw new Error('Disconnect the existing cloud connection first.');
  const info=await getLocalWorkspaceInfo(db);if(!info)throw new Error('Set up this device first.');
  const send=async<T>(action:string,body:unknown):Promise<T>=>{
    const response=await request(`/api/cloud?action=${action}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error??'Cloud connection failed.'),{status:response.status});return value;
  };
  await send('login',{email:input.email,password:input.password});
  const sourceId=`source-${crypto.randomUUID()}`;
  const enrolled=await send<CloudEnrollmentResult>('enroll',{sourceId,workspaceId:info.workspaceId,businessName:info.businessName,deviceName:input.deviceName});
  const baseline=await db.transaction('r',db.records,db.metadata,async()=>{
    const rows=(await db.records.toArray()).map(({kind,id,branchId,value})=>({kind,id,branchId,value}));
    rows.push({kind:'settings',id:'settings',branchId:null,value:(await db.metadata.get('settings'))?.value});
    return {chunks:cloudChunks(monitoringChanges(rows)),index:0,cursor:Number((await db.metadata.get('journalSequence'))?.value??0)};
  });
  const connection:Connection={...enrolled,deviceName:input.deviceName,businessName:info.businessName,baseline,sequence:0,cursor:0,lastUploadedAt:null,lastSeenAt:null,lastError:'',needsReconnect:false};
  await db.metadata.put({key,value:connection});changed();return (await getCloudSyncState(db))!;
}
export async function disconnectDeviceCloud(options:Options={}){
  const db=options.db??localDb;if((await getLocalUser(db))?.role!=='owner')throw new Error('Only the owner can disconnect this device.');
  await db.metadata.delete(key);changed();
}
export async function autoConnectDeviceToCloud(options:Options={}):Promise<CloudSyncState|null>{
  const db=options.db??localDb,request=options.fetch??fetch;
  if(await db.metadata.get(key))return getCloudSyncState(db);
  const info=await getLocalWorkspaceInfo(db);if(!info)return null;
  try{
    const activeRes=await request('/api/cloud?action=active-source',{signal:AbortSignal.timeout(10000)}).catch(()=>null);
    let targetSourceId='main-store';
    if(activeRes&&activeRes.ok){
      const active=await activeRes.json();
      if(active.sourceId)targetSourceId=active.sourceId;
    }
    const response=await request('/api/cloud?action=auto-enroll',{
      method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({sourceId:targetSourceId,workspaceId:info.workspaceId,businessName:info.businessName,deviceName:'POS Device'}),
      signal:AbortSignal.timeout(15000)
    });
    if(!response.ok)return null;
    const enrolled=await response.json() as CloudEnrollmentResult;
    const baseline=await db.transaction('r',db.records,db.metadata,async()=>{
      const rows=(await db.records.toArray()).map(({kind,id,branchId,value})=>({kind,id,branchId,value}));
      rows.push({kind:'settings',id:'settings',branchId:null,value:(await db.metadata.get('settings'))?.value});
      return {chunks:cloudChunks(monitoringChanges(rows)),index:0,cursor:Number((await db.metadata.get('journalSequence'))?.value??0)};
    });
    const connection:Connection={...enrolled,deviceName:'POS Device',businessName:info.businessName,baseline,sequence:0,cursor:0,lastUploadedAt:null,lastSeenAt:null,lastError:'',needsReconnect:false};
    await db.metadata.put({key,value:connection});changed();
    return await getCloudSyncState(db);
  }catch{return null;}
}
export async function rehydrateFromCloud(db:LocalDatabase=localDb,request:typeof fetch=fetch):Promise<boolean>{
  try{
    const activeRes=await request('/api/cloud?action=active-source',{signal:AbortSignal.timeout(10000)}).catch(()=>null);
    if(!activeRes||!activeRes.ok)return false;
    const active=await activeRes.json();
    const sourceId=active.sourceId||'main-store';
    const snapRes=await request(`/api/cloud?action=snapshot&sourceId=${encodeURIComponent(sourceId)}`,{signal:AbortSignal.timeout(15000)}).catch(()=>null);
    if(!snapRes||!snapRes.ok)return false;
    const snap=await snapRes.json() as {source?:any;records?:Array<{kind:string;id:string;branchId:string|null;value:Record<string,unknown>}>;settings?:Record<string,unknown>};
    if(!snap.records||snap.records.length===0)return false;

    const enrollRes=await request('/api/cloud?action=auto-enroll',{
      method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({sourceId,businessName:snap.source?.businessName||'Hotel POS',deviceName:'Restored Device',workspaceId:snap.source?.workspaceId||'ws-main'}),
      signal:AbortSignal.timeout(15000)
    }).catch(()=>null);
    const enrolled=enrollRes&&enrollRes.ok?await enrollRes.json():null;

    const nowStr=new Date().toISOString();
    const {createLocalCredential,prepareLocalSession,rememberLocalSession}=await import('./local/auth');
    const ownerId='staff-owner';
    const credential=await createLocalCredential(ownerId,'1234');
    const authenticated=await prepareLocalSession(ownerId);

    await db.transaction('rw',db.tables,async()=>{
      await db.records.clear();
      for(const r of snap.records!){
        if(r.kind==='settings')continue;
        await db.records.put({
          kind:r.kind,
          id:r.id,
          branchId:r.branchId??null,
          value:r.value,
          createdAt:(r.value as any)?.createdAt||nowStr,
          updatedAt:(r.value as any)?.updatedAt||nowStr,
        });
      }
      const workspaceInfo={
        version:1,
        workspaceId:snap.source?.workspaceId||'ws-main',
        deviceId:`dev-${crypto.randomUUID().slice(0,8)}`,
        businessName:snap.source?.businessName||(snap.settings?.businessName as string)||'Hotel POS',
        demo:false,
        createdAt:nowStr,
      };
      await db.metadata.put({key:'workspace',value:workspaceInfo});
      if(snap.settings)await db.metadata.put({key:'settings',value:snap.settings});
      await db.metadata.put({key:'activeBranchId',value:'b1'});
      await db.metadata.put({key:'journalSequence',value:0});
      await db.metadata.put({key:'storagePersistenceAttempted',value:true});

      await db.credentials.put(credential);
      await db.sessions.put(authenticated.session);

      if(enrolled){
        const connection:Connection={
          ...enrolled,
          deviceName:'Restored Device',
          businessName:workspaceInfo.businessName,
          baseline:null,
          sequence:0,
          cursor:0,
          lastUploadedAt:nowStr,
          lastSeenAt:nowStr,
          lastError:'',
          needsReconnect:false,
        };
        await db.metadata.put({key,value:connection});
      }
    });

    rememberLocalSession(db,authenticated.sessionToken);
    changed();
    if(typeof window!=='undefined'){
      window.dispatchEvent(new CustomEvent('local-workspace-change'));
      window.dispatchEvent(new CustomEvent('local-workspace-restored'));
    }
    return true;
  }catch{return false;}
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

    // Two-way sync: Pull remote records into local IndexedDB
    try{
      const snapRes=await request(`/api/cloud?action=snapshot&sourceId=${encodeURIComponent(connection.sourceId)}`,{signal:AbortSignal.timeout(15000)}).catch(()=>null);
      if(snapRes&&snapRes.ok){
        const snap=await snapRes.json() as {records?:Array<{kind:string;id:string;branchId:string|null;value:Record<string,unknown>}>;settings?:unknown};
        if(Array.isArray(snap.records)&&snap.records.length>0){
          let updatedCount=0;
          const nowStr=new Date().toISOString();
          await db.transaction('rw',db.records,db.metadata,async()=>{
            for(const r of snap.records!){
              if(r.kind==='settings')continue;
              const current=await db.records.get([r.kind,r.id]);
              const curTime=(current?.value as any)?.updatedAt||current?.updatedAt||'';
              const newTime=(r.value as any)?.updatedAt||(r.value as any)?.createdAt||'';
              if(!current||(newTime&&newTime>curTime)){
                await db.records.put({
                  kind:r.kind,
                  id:r.id,
                  branchId:r.branchId??null,
                  value:r.value,
                  createdAt:(r.value as any)?.createdAt||current?.createdAt||nowStr,
                  updatedAt:(r.value as any)?.updatedAt||nowStr,
                });
                updatedCount++;
              }
            }
            if(snap.settings&&typeof snap.settings==='object'){
              const curSettings=(await db.metadata.get('settings'))?.value;
              if(JSON.stringify(curSettings)!==JSON.stringify(snap.settings)){
                await db.metadata.put({key:'settings',value:snap.settings});
                updatedCount++;
              }
            }
          });
          if(updatedCount>0&&typeof window!=='undefined'){
            window.dispatchEvent(new CustomEvent('local-workspace-change'));
          }
        }
      }
    }catch{/* Pull errors do not block local usage */}
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

