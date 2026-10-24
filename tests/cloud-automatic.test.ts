import {test} from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {LocalDatabase} from '../src/lib/local/db';
import {initializeLocalWorkspace} from '../src/lib/local/seed';
import {openAutomaticCloudWorkspace,connectDeviceToCloud,syncDeviceCloud} from '../src/lib/cloud-sync';
import {createLocalApi} from '../src/lib/local/core';
import {logoutLocal,getLocalUser} from '../src/lib/local/auth';
import {createMonitorHandler} from '../server/monitor/handler';
import {MemoryMonitorStore,recordKey} from '../server/monitor/store';

const env={CLOUD_OWNER_EMAIL:'automatic@example.test',CLOUD_OWNER_PASSWORD:'automatic-test-password-1927',CLOUD_SESSION_SECRET:'a'.repeat(64)};
function fixture(configuration:NodeJS.ProcessEnv={...env}){
  const store=new MemoryMonitorStore(),handler=createMonitorHandler({store,env:configuration});
  const client=()=>{
    let cookie='';
    const request:typeof fetch=async(input,init)=>{
      const url=new URL(String(input),'https://automatic.test'),headers=new Headers(init?.headers);
      headers.set('Origin',url.origin);
      if(init?.credentials!=='omit'&&cookie)headers.set('Cookie',cookie);
      const response=await handler(new Request(url,{...init,headers}));
      if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie')!.split(';')[0];
      return response;
    };
    const call=(action:string,body:unknown)=>request(`/api/cloud?action=${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const login=()=>call('login',{email:env.CLOUD_OWNER_EMAIL,password:env.CLOUD_OWNER_PASSWORD});
    return {request,call,login};
  };
  return {store,client};
}
const empty=()=>new LocalDatabase(`automatic-${crypto.randomUUID()}`);

test('automatic cloud connection still requires owner authentication and creates no anonymous database',async()=>{
  const f=fixture(),client=f.client(),db=empty();
  try{await assert.rejects(openAutomaticCloudWorkspace({db,fetch:client.request}),/Sign in/);assert.equal((await f.store.list()).length,0);assert.equal(await db.records.count(),0);}
  finally{await db.delete();}
});

test('four new devices automatically open one cloud business without connection settings or default PINs',async()=>{
  const f=fixture(),clients=Array.from({length:4},()=>f.client()),databases=clients.map(()=>empty());
  try{
    await Promise.all(clients.map(client=>client.login()));
    const sources=await Promise.all(clients.map((client,index)=>openAutomaticCloudWorkspace({db:databases[index],fetch:client.request})));
    assert.deepEqual(sources,['main-store','main-store','main-store','main-store']);
    const [source]=await f.store.list();assert.equal((await f.store.list()).length,1);assert.equal(source.shared,true);assert.equal(source.ready,true);
    const data=(await f.store.get(source.sourceId))!;assert.equal(data.records[recordKey('settings','settings')].value.businessName,'DEMO HOTEL');
    for(const db of databases){assert.equal(await db.records.count(),0);assert.equal(await db.credentials.count(),0);}
  }finally{await Promise.all(databases.map(db=>db.delete()));}
});

test('the first signed-in local owner is transferred once; later devices never overwrite existing cloud stock',async()=>{
  const f=fixture(),first=f.client(),second=f.client(),db=empty(),other=empty();
  try{
    await initializeLocalWorkspace({businessName:'Saved Shop',ownerName:'Original Owner',pin:'98765432',demo:true},db);
    await first.login();const sourceId=await openAutomaticCloudWorkspace({db,fetch:first.request});assert.ok(sourceId);
    const before=(await f.store.get(sourceId))!;assert.equal(before.source.shared,true);assert.equal(before.source.businessName,'Saved Shop');
    assert.equal(before.records[recordKey('inventory','b1-rice')].value.quantity,86);assert.equal(await db.credentials.count(),1);
    await initializeLocalWorkspace({businessName:'Different Local Copy',ownerName:'Second Owner',pin:'98765432',demo:true},other);
    const local=(await other.records.get(['inventory','b1-rice']))!;local.value={...local.value as object,quantity:999};await other.records.put(local);
    await second.login();assert.equal(await openAutomaticCloudWorkspace({db:other,fetch:second.request}),sourceId);
    assert.deepEqual((await f.store.get(sourceId))!.records,before.records);assert.equal(((await other.records.get(['inventory','b1-rice']))!.value as {quantity:number}).quantity,999);
    assert.equal((await f.store.list()).length,1);
  }finally{await db.delete();await other.delete();}
});

test('an incomplete original upload is preserved and does not cause a competing empty shared workspace',async()=>{
  const f=fixture(),client=f.client(),db=empty();
  try{
    await client.login();assert.equal((await client.call('enroll',{sourceId:'upload-in-progress',workspaceId:'original-business',businessName:'Original Shop',deviceName:'Original counter'})).status,200);
    assert.equal(await openAutomaticCloudWorkspace({db,fetch:client.request}),null);
    assert.equal((await f.store.list()).length,1);assert.equal(await f.store.get('main-store'),null);
  }finally{await db.delete();}
});

test('automatic handoff uploads the original counter pending sale before enabling shared authority',async()=>{
  const f=fixture(),client=f.client(),db=empty();
  try{
    await initializeLocalWorkspace({businessName:'Pending Sale Shop',ownerName:'Original Owner',pin:'98765432',demo:true},db);
    const connected=await connectDeviceToCloud({email:env.CLOUD_OWNER_EMAIL,password:env.CLOUD_OWNER_PASSWORD,deviceName:'Original counter'},{db,fetch:client.request});
    await syncDeviceCloud({db,fetch:client.request});
    const api=createLocalApi(db);
    await api('/orders',{commandId:crypto.randomUUID(),branchId:'b1',type:'takeaway',lines:[{menuItemId:'m1',quantity:1}]});
    assert.equal(Object.values((await f.store.get(connected.sourceId))!.records).filter(row=>row.kind==='order').length,0);
    assert.equal(await openAutomaticCloudWorkspace({db,fetch:client.request}),connected.sourceId);
    const saved=(await f.store.get(connected.sourceId))!;
    assert.equal(saved.source.shared,true);assert.equal(Object.values(saved.records).filter(row=>row.kind==='order').length,1);
    assert.equal(saved.records[recordKey('inventory','b1-prepared-m1')].value.quantity,49);
  }finally{await db.delete();}
});

test('one verified POS PIN transfers a signed-out original device without a second local login',async()=>{
  const f=fixture({CLOUD_POS_PIN:'98765432',CLOUD_SESSION_SECRET:'p'.repeat(64)}),client=f.client(),db=empty();
  try{
    await initializeLocalWorkspace({businessName:'Saved Original Shop',ownerName:'Original Owner',pin:'65432198',demo:true},db);
    await logoutLocal(db);assert.equal(await getLocalUser(db),null);
    await assert.rejects(openAutomaticCloudWorkspace({db,fetch:client.request}),/Sign in/);
    assert.equal((await client.call('pos-login',{pin:'98765432'})).status,200);
    const sourceId=await openAutomaticCloudWorkspace({db,fetch:client.request});assert.ok(sourceId);
    const saved=(await f.store.get(sourceId))!;
    assert.equal(saved.source.businessName,'Saved Original Shop');assert.equal(saved.source.shared,true);
    assert.equal(saved.records[recordKey('inventory','b1-rice')].value.quantity,86);
    assert.equal(await db.credentials.count(),1);assert.equal(await getLocalUser(db),null);
  }finally{await db.delete();}
});

test('a POS PIN update renews the original grant and uploads pending sales without creating another source',async()=>{
  const configuration={...env,CLOUD_POS_PIN:'98765432'},f=fixture(configuration),client=f.client(),db=empty();
  try{
    await initializeLocalWorkspace({businessName:'PIN Update Shop',ownerName:'Original Owner',pin:'65432198',demo:true},db);
    const connected=await connectDeviceToCloud({email:env.CLOUD_OWNER_EMAIL,password:env.CLOUD_OWNER_PASSWORD,deviceName:'Original counter'},{db,fetch:client.request});
    await syncDeviceCloud({db,fetch:client.request});
    await createLocalApi(db)('/orders',{commandId:crypto.randomUUID(),branchId:'b1',type:'takeaway',lines:[{menuItemId:'m1',quantity:1}]});
    configuration.CLOUD_POS_PIN='87654321';
    assert.equal((await client.call('pos-login',{pin:'87654321'})).status,200);
    assert.equal(await openAutomaticCloudWorkspace({db,fetch:client.request}),connected.sourceId);
    const saved=(await f.store.get(connected.sourceId))!;
    assert.equal((await f.store.list()).length,1);assert.equal(saved.source.shared,true);
    assert.equal(Object.values(saved.records).filter(row=>row.kind==='order').length,1);
    assert.equal(saved.records[recordKey('inventory','b1-prepared-m1')].value.quantity,49);
  }finally{await db.delete();}
});
