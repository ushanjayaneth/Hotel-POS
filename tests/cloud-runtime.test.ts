import {test} from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {LocalDatabase} from '../src/lib/local/db';
import {initializeLocalWorkspace} from '../src/lib/local/seed';
import {monitoringChanges} from '../src/lib/cloud-sync';
import {cacheCloudState,getCloudOfflineReplica,offlineApi,offlineSession} from '../src/lib/cloud-offline';
import {cloudPOSUser,cloudRuntimeApi,retryCloudConnection} from '../src/lib/cloud-runtime';
import type {Snapshot} from '../shared/types';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(accept=>{resolve=accept;});return {promise,resolve};}
async function deadline<T>(promise:Promise<T>){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Prepared local data waited for the stalled cloud.')),750);})]);}
  finally{clearTimeout(timer);}
}
async function fixture(){
  const sourceId=`runtime-${crypto.randomUUID()}`,original=new LocalDatabase(`runtime-source-${crypto.randomUUID()}`);
  await initializeLocalWorkspace({businessName:'Local First Hotel',ownerName:'Owner',pin:'98765432',demo:true},original);
  const records=monitoringChanges(await original.records.toArray());
  const settings=(await original.metadata.get('settings'))!.value;
  const state={sourceId,cloudVersion:1,records,metadata:{settings,activeBranchId:'b1',deviceId:'cloud'}};
  await cacheCloudState(sourceId,state,cloudPOSUser);
  const local=await offlineApi<Snapshot>(sourceId,'/bootstrap?branchId=b1');
  return {sourceId,local,state,close:async()=>{await original.delete();await getCloudOfflineReplica(sourceId).db.delete();}};
}

test('prepared snapshots and supported report reads finish while a single cloud refresh is still stalled',async()=>{
  const f=await fixture(),originalFetch=globalThis.fetch,originalWindow=globalThis.window;
  const target=new EventTarget();Object.defineProperty(globalThis,'window',{value:target,configurable:true,writable:true});
  const response=deferred<Response>(),requested=deferred<void>(),completed=deferred<void>();let requests=0;
  target.addEventListener('cloud-runtime-refresh',()=>completed.resolve());
  globalThis.fetch=async()=>{requests++;requested.resolve();return response.promise;};
  try{
    const first=await deadline(cloudRuntimeApi<Snapshot>(f.sourceId,'/bootstrap?branchId=b1'));
    assert.equal(first.menu.length,12);await requested.promise;
    const again=await deadline(cloudRuntimeApi<Snapshot>(f.sourceId,'/bootstrap?branchId=b1'));
    assert.equal(again.menu[0].name,first.menu[0].name);assert.equal(requests,1);
    const csv=await deadline(cloudRuntimeApi<string>(f.sourceId,'/reports/income-expenses?branchId=b1&from=2026-10-01&to=2026-10-31&format=csv'));
    assert.equal(typeof csv,'string');assert.equal(requests,1);
    response.resolve(Response.json({...f.local,cloudVersion:1,offlineState:f.state}));
    await completed.promise;
    // The UI's completion event refresh only re-reads local data, without a
    // response-driven request loop or a second cloud probe.
    await cloudRuntimeApi(f.sourceId,'/bootstrap?branchId=b1');assert.equal(requests,1);
  }finally{response.resolve(Response.json({...f.local,cloudVersion:1,offlineState:f.state}));await completed.promise;globalThis.fetch=originalFetch;Object.defineProperty(globalThis,'window',{value:originalWindow,configurable:true,writable:true});await f.close();}
});

test('a remembered session opens immediately but a rejected background verification clears only its source',async()=>{
  const f=await fixture(),other=await fixture(),originalFetch=globalThis.fetch,originalWindow=globalThis.window;
  const target=new EventTarget();Object.defineProperty(globalThis,'window',{value:target,configurable:true,writable:true});
  const response=deferred<Response>(),rejected=deferred<void>();let requests=0;
  target.addEventListener('cloud-runtime-session',(event:Event)=>{if((event as CustomEvent).detail.sourceId===f.sourceId)rejected.resolve();});
  globalThis.fetch=async()=>{requests++;return response.promise;};
  try{
    const first=await deadline(cloudRuntimeApi<{user:typeof cloudPOSUser}>(f.sourceId,'/session'));
    const second=await deadline(cloudRuntimeApi<{user:typeof cloudPOSUser}>(f.sourceId,'/session'));
    assert.equal(first.user.id,'cloud-owner');assert.equal(second.user.id,'cloud-owner');assert.equal(requests,1);
    response.resolve(Response.json({authenticated:false}));await rejected.promise;
    assert.equal(await offlineSession(f.sourceId),null);assert.equal((await offlineSession(other.sourceId))?.id,'cloud-owner');
    retryCloudConnection(f.sourceId);
    const current=await cloudRuntimeApi<{user:null}>(f.sourceId,'/session');assert.equal(current.user,null);
  }finally{response.resolve(Response.json({authenticated:false}));globalThis.fetch=originalFetch;Object.defineProperty(globalThis,'window',{value:originalWindow,configurable:true,writable:true});await f.close();await other.close();}
});
