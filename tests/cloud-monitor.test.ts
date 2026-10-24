import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import 'fake-indexeddb/auto';
import {LocalDatabase} from '../src/lib/local/db';
import {initializeLocalWorkspace} from '../src/lib/local/seed';
import {createLocalApi} from '../src/lib/local/core';
import {buildBackupPayload} from '../src/lib/local/backup';
import {connectDeviceToCloud,getCloudSyncState,syncDeviceCloud,cloudChunks,monitoringChanges} from '../src/lib/cloud-sync';
import {createMonitorHandler} from '../server/monitor/handler';
import {MemoryMonitorStore,recordKey} from '../server/monitor/store';
import type {CloudChange,CloudSnapshot} from '../shared/cloud-monitor';
import {monitoringSnapshot} from '../shared/cloud-view';
import type {InventoryItem,Order,Snapshot} from '../shared/types';

const env={CLOUD_OWNER_EMAIL:'owner@example.test',CLOUD_OWNER_PASSWORD:'test-cloud-password-1927',CLOUD_SESSION_SECRET:'a'.repeat(64)};
async function fixture(){
  const store=new MemoryMonitorStore(),handler=createMonitorHandler({store,env});let loseAck=false;
  const client=()=>{
    let cookie='';
    const request:typeof fetch=async(input,init)=>{
      const url=new URL(String(input),'https://pos.example.test');
      const headers=new Headers(init?.headers);headers.set('Origin',url.origin);
      if(init?.credentials!=='omit'&&cookie)headers.set('Cookie',cookie);
      const response=await handler(new Request(url,{...init,headers}));
      if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie')!.split(';')[0];
      if(loseAck&&url.searchParams.get('action')==='push'&&response.ok){loseAck=false;throw new Error('Acknowledgement connection lost');}
      return response;
    };
    const call=async(action:string,body?:unknown,headers?:HeadersInit)=>request(`/api/cloud?action=${action}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {request,call};
  };
  const {request,call}=client();
  const db=new LocalDatabase(`cloud-test-${crypto.randomUUID()}`);
  await initializeLocalWorkspace({businessName:'Cloud Test Hotel',ownerName:'Test Owner',pin:'98765432',demo:true},db);
  return {store,handler,request,call,client,db,loseNextAck:()=>{loseAck=true;},close:()=>db.delete()};
}

test('cloud endpoints require configuration, private owner session and same-origin enrollment',async()=>{
  const unconfigured=createMonitorHandler({env:{}});
  assert.equal((await unconfigured(new Request('https://pos.test/api/cloud?action=session'))).status,503);
  const f=await fixture();try{
    assert.equal((await f.call('sources')).status,401);
    const evil=await f.handler(new Request('https://pos.example.test/api/cloud?action=login',{method:'POST',headers:{Origin:'https://evil.test','Content-Type':'application/json'},body:JSON.stringify({email:env.CLOUD_OWNER_EMAIL,password:env.CLOUD_OWNER_PASSWORD})}));assert.equal(evil.status,403);
    assert.equal((await f.call('login',{email:env.CLOUD_OWNER_EMAIL,password:env.CLOUD_OWNER_PASSWORD})).status,200);
    assert.equal((await f.call('sources')).status,200);
    for(let i=0;i<12;i++)await f.call('login',{email:env.CLOUD_OWNER_EMAIL,password:'incorrect'});
    assert.equal((await f.call('login',{email:env.CLOUD_OWNER_EMAIL,password:env.CLOUD_OWNER_PASSWORD})).status,429);
  }finally{await f.close();}
});

test('anonymous enrollment cannot create a source or acquire an existing device write grant',async()=>{
  const f=await fixture();try{
    const anonymous=async(action:string,body:unknown)=>f.handler(new Request(`https://pos.example.test/api/cloud?action=${action}`,{
      method:'POST',headers:{Origin:'https://pos.example.test','Content-Type':'application/json'},body:JSON.stringify(body)
    }));
    const enrollment={sourceId:'anonymous-source-attempt',workspaceId:'workspace-test',businessName:'Another shop',deviceName:'Another phone'};
    assert.equal((await anonymous('enroll',enrollment)).status,401);
    assert.equal((await anonymous('auto-enroll',enrollment)).status,401);
    assert.equal(await f.store.get(enrollment.sourceId),null);

    await connectDeviceToCloud({email:env.CLOUD_OWNER_EMAIL,password:env.CLOUD_OWNER_PASSWORD,deviceName:'Protected shop'},{db:f.db,fetch:f.request});
    const state=(await syncDeviceCloud({db:f.db,fetch:f.request}))!;
    const before=(await f.store.get(state.sourceId))!;
    const stranger=f.client();
    for(const action of ['sources','active-source',`snapshot&sourceId=${state.sourceId}`,`bootstrap&sourceId=${state.sourceId}`])assert.equal((await stranger.call(action)).status,401,action);
    assert.equal((await anonymous('auto-enroll',{...enrollment,sourceId:state.sourceId})).status,401);
    assert.equal((await f.call('auto-enroll',{...enrollment,sourceId:state.sourceId})).status,410);
    const overwrite=await anonymous('push',{sourceId:state.sourceId,epoch:before.source.epoch,sequence:before.source.sequence+1,eventId:'anonymous-overwrite',ready:true,changes:[]});
    assert.equal(overwrite.status,401);
    assert.deepEqual(await f.store.get(state.sourceId),before);
  }finally{await f.close();}
});

test('concurrent owner pairing issues a grant only for the enrollment committed to cloud storage',async()=>{
  const f=await fixture();try{
    await f.call('login',{email:env.CLOUD_OWNER_EMAIL,password:env.CLOUD_OWNER_PASSWORD});
    const input={sourceId:'concurrent-pairing-source',workspaceId:'workspace-test',businessName:'Concurrent shop',deviceName:'Counter A'};
    const responses=await Promise.all([f.call('enroll',input),f.call('enroll',{...input,deviceName:'Counter B'})]);
    assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
    const winner=await responses.find(response=>response.status===200)!.json() as {sourceId:string;epoch:string;token:string};
    const loser=await responses.find(response=>response.status===409)!.json() as Record<string,unknown>;
    assert.equal(loser.token,undefined);
    assert.equal((await f.store.get(input.sourceId))!.source.epoch,winner.epoch);
    const heartbeat=await f.call('heartbeat',{sourceId:winner.sourceId,epoch:winner.epoch},{Authorization:`Bearer ${winner.token}`});
    assert.equal(heartbeat.status,200);
    assert.equal((await f.call('enroll',input)).status,409);
  }finally{await f.close();}
});

test('background sync does not enroll an unpaired device or send business data',async()=>{
  const f=await fixture();try{
    let requests=0;
    const request:typeof fetch=async()=>{requests++;throw new Error('Unpaired devices must not contact the cloud.');};
    assert.equal(await syncDeviceCloud({db:f.db,fetch:request}),null);
    assert.equal(requests,0);
    assert.equal(await getCloudSyncState(f.db),null);
    assert.deepEqual(await f.store.list(),[]);
  }finally{await f.close();}
});

test('legacy anonymous-era writer and v2 grants are rejected without deleting the local journal or cloud records',async()=>{
  const f=await fixture();try{
    await connectDeviceToCloud({email:env.CLOUD_OWNER_EMAIL,password:env.CLOUD_OWNER_PASSWORD,deviceName:'Legacy counter'},{db:f.db,fetch:f.request});
    const state=(await syncDeviceCloud({db:f.db,fetch:f.request}))!;
    const before=(await f.store.get(state.sourceId))!;
    const row=(await f.db.metadata.get('cloudMonitor:connection'))!;
    const connection=row.value as {token:string};
    const payload=JSON.parse(Buffer.from(connection.token.split('.')[0],'base64url').toString()) as Record<string,unknown>;
    assert.equal(payload.purpose,'owner-paired-writer-v3');
    const oldGrant=(purpose:string)=>{
      const text=Buffer.from(JSON.stringify({...payload,purpose})).toString('base64url');
      return `${text}.${createHmac('sha256',env.CLOUD_SESSION_SECRET).update(text).digest('base64url')}`;
    };
    const token=oldGrant('owner-paired-writer-v2');
    await f.db.metadata.put({...row,value:{...row.value as object,token}});
    await createLocalApi(f.db)('/orders',{commandId:'legacy-pending-local-sale',branchId:'b1',type:'takeaway',lines:[{menuItemId:'m1',quantity:1}]});
    const journal=await f.db.journal.toArray(),records=await f.db.records.toArray();
    const rejected=(await syncDeviceCloud({db:f.db,fetch:f.request}))!;
    assert.equal(rejected.needsReconnect,true);assert.ok(rejected.pending>0);assert.match(rejected.lastError,/older cloud connection.*Reconnect/);
    assert.deepEqual(await f.db.journal.toArray(),journal);assert.deepEqual(await f.db.records.toArray(),records);
    assert.deepEqual(await f.store.get(state.sourceId),before);
    const heartbeat=await f.call('heartbeat',{sourceId:state.sourceId,epoch:before.source.epoch},{Authorization:`Bearer ${token}`});
    assert.equal(heartbeat.status,401);assert.equal((await heartbeat.json()).code,'DEVICE_RECONNECT_REQUIRED');
    assert.equal((await f.call('heartbeat',{sourceId:state.sourceId,epoch:before.source.epoch},{Authorization:`Bearer ${oldGrant('writer')}`})).status,401);
  }finally{await f.close();}
});

test('offline baseline and lost acknowledgements retry without leaking credentials, duplicating sales or losing balances',async()=>{
  const f=await fixture();try{
    await connectDeviceToCloud({email:env.CLOUD_OWNER_EMAIL,password:env.CLOUD_OWNER_PASSWORD,deviceName:'Cashier A'},{db:f.db,fetch:f.request});
    f.loseNextAck();let state=await syncDeviceCloud({db:f.db,fetch:f.request});assert.match(state!.lastError,/lost/);
    state=await syncDeviceCloud({db:f.db,fetch:f.request});assert.equal(state!.pending,0);assert.equal(state!.lastError,'');
    const sourceId=state!.sourceId;
    let cloud=await (await f.call(`snapshot&sourceId=${sourceId}`)).json() as CloudSnapshot;
    const serialized=JSON.stringify(cloud);assert.doesNotMatch(serialized,/98765432|"salt"|"hash"|"token"|"credentials"/);
    assert.equal(cloud.source.ready,true);assert.equal(monitoringSnapshot(cloud.records).menu.length,12);
    const api=createLocalApi(f.db);
    const sale=await api<{order:Order}>('/orders',{commandId:'cloud-local-sale-001',branchId:'b1',type:'takeaway',lines:[{menuItemId:'m1',quantity:1}]});
    const customer=await api<{customer:{id:string}}>('/customers',{commandId:'cloud-local-customer-001',name:'Cloud Loan Guest',phone:'0771234567',email:''});
    await api(`/orders/${sale.order.id}/payments`,{commandId:'cloud-local-payment-001',expectedVersion:sale.order.version,method:'credit',customerId:customer.customer.id,amount:sale.order.total,received:sale.order.total});
    await api(`/customers/${customer.customer.id}/collections`,{commandId:'cloud-local-collection-001',branchId:'b1',amount:20000,method:'cash',reference:'',note:''});
    state=await syncDeviceCloud({db:f.db,fetch:f.request});assert.equal(state!.pending,0);
    cloud=await (await f.call(`snapshot&sourceId=${sourceId}`)).json();const view=monitoringSnapshot(cloud.records);
    assert.equal(view.orders.length,1);assert.equal(view.customers.find(row=>row.id===customer.customer.id)!.balance,45000);
    assert.equal(view.inventory.find(row=>row.id==='b1-prepared-m1')!.quantity,49);
    const backup=await buildBackupPayload(f.db);assert.equal(backup.tables.metadata.some(row=>row.key.startsWith('cloudMonitor:')),false);
    await f.call('revoke',{sourceId});state=await syncDeviceCloud({db:f.db,fetch:f.request});assert.equal(state!.needsReconnect,true);
    assert.equal((await f.call(`snapshot&sourceId=${sourceId}`)).status,404);
  }finally{await f.close();}
});

test('four authenticated shared devices cannot oversell stock, duplicate commands or overwrite cloud with local uploads',async()=>{
  const f=await fixture();try{
    await connectDeviceToCloud({email:env.CLOUD_OWNER_EMAIL,password:env.CLOUD_OWNER_PASSWORD,deviceName:'Main shop'},{db:f.db,fetch:f.request});
    const state=(await syncDeviceCloud({db:f.db,fetch:f.request}))!;const sourceId=state.sourceId;
    assert.equal((await f.call('promote',{sourceId})).status,200);
    assert.equal((await syncDeviceCloud({db:f.db,fetch:f.request}))!.shared,true);
    const beforeUpload=(await f.store.get(sourceId))!;
    const connection=(await f.db.metadata.get('cloudMonitor:connection'))!.value as {token:string;epoch:string};
    const overwrite=await f.call('push',{sourceId,epoch:connection.epoch,sequence:beforeUpload.source.sequence+1,eventId:'late-independent-upload',ready:true,changes:[{kind:'inventory',id:'b1-prepared-m1',branchId:'b1',value:{...beforeUpload.records[recordKey('inventory','b1-prepared-m1')].value,quantity:999}}]},{Authorization:`Bearer ${connection.token}`});
    assert.equal(overwrite.status,409);assert.equal((await overwrite.json()).code,'SHARED_WORKSPACE');assert.deepEqual(await f.store.get(sourceId),beforeUpload);
    const clients=Array.from({length:4},()=>f.client());
    for(const client of clients)assert.equal((await client.call('login',{email:env.CLOUD_OWNER_EMAIL,password:env.CLOUD_OWNER_PASSWORD})).status,200);
    const projection=(await f.store.get(sourceId))!;const stock=projection.records[recordKey('inventory','b1-prepared-m1')];(stock.value as unknown as InventoryItem).quantity=3;
    projection.revision++;await f.store.replace(sourceId,projection.revision-1,projection);
    const command=(commandId:string)=>({sourceId,path:'/orders',method:'POST',body:{commandId,branchId:'b1',type:'takeaway',lines:[{menuItemId:'m1',quantity:1}]}});
    const attempts=await Promise.all(clients.map((client,index)=>client.call('command',command(`shared-order-command-${index}`))));
    assert.deepEqual(attempts.map(response=>response.status).sort(),[200,200,200,409]);
    const winner=`shared-order-command-${attempts.findIndex(response=>response.status===200)}`;
    const replay=await f.call('command',command(winner));assert.equal(replay.status,200);
    const replayId=(await replay.json()).order.id;
    for(const client of clients){const replayed=await client.call('command',command(winner));assert.equal(replayed.status,200);assert.equal((await replayed.json()).order.id,replayId);}
    const result=await f.store.get(sourceId);assert.equal((result!.records[recordKey('inventory','b1-prepared-m1')].value as unknown as InventoryItem).quantity,0);
    assert.equal(Object.values(result!.records).filter(row=>row.kind==='order').length,3);
    assert.equal((await f.call('command',{...command(winner),body:{...command(winner).body,note:'Changed replay'}})).status,409);
    for(const client of clients){const bootstrap=await (await client.call(`bootstrap&sourceId=${sourceId}&branchId=b1`)).json() as Snapshot;assert.equal(bootstrap.orders.length,3);assert.equal(bootstrap.inventory.find(row=>row.id==='b1-prepared-m1')!.quantity,0);}
    assert.equal((await f.call('command',{sourceId,path:'/staff',method:'POST',body:{commandId:'blocked-staff-command'}})).status,403);
  }finally{await f.close();}
});

test('cloud packet sizes are bounded and credential tables/media never enter monitoring records',()=>{
  const rows=monitoringChanges([{kind:'credentials',id:'private',branchId:null,value:{hash:'private'}},{kind:'media',id:'photo',branchId:null,value:{data:'bytes'}},{kind:'customer',id:'c1',branchId:null,value:{id:'c1',name:'Name',password:'private'}}]);
  assert.equal(rows.length,1);assert.equal(rows[0].value.password,undefined);
  const records:Array<CloudChange>=Array.from({length:251},(_,index)=>({kind:'customer',id:`c${index}`,branchId:null,value:{id:`c${index}`,name:'a'.repeat(1000)}}));
  const chunks=cloudChunks(records,50000);assert.equal(chunks.flat().length,251);assert.ok(chunks.every(chunk=>Buffer.byteLength(JSON.stringify(chunk))<50000));
});

test('a fresh authenticated device discovers and recovers the existing shared workspace without replacing records or credentials',async()=>{
  const f=await fixture();try{
    const fresh=f.client();assert.equal((await fresh.call('active-source')).status,401);
    await f.call('login',{email:env.CLOUD_OWNER_EMAIL,password:env.CLOUD_OWNER_PASSWORD});
    assert.deepEqual(await (await f.call('active-source')).json(),{sourceId:null,shared:false,selectionRequired:false});
    await connectDeviceToCloud({email:env.CLOUD_OWNER_EMAIL,password:env.CLOUD_OWNER_PASSWORD,deviceName:'Recovery counter'},{db:f.db,fetch:f.request});
    const sale=await createLocalApi(f.db)<{order:Order}>('/orders',{commandId:'recover-existing-order-01',branchId:'b1',type:'takeaway',lines:[{menuItemId:'m1',quantity:2}]});
    const state=(await syncDeviceCloud({db:f.db,fetch:f.request}))!;
    assert.deepEqual(await (await f.call('active-source')).json(),{sourceId:null,shared:false,selectionRequired:false});
    assert.equal((await f.call('promote',{sourceId:state.sourceId})).status,200);
    const before=(await f.store.get(state.sourceId))!;
    await fresh.call('login',{email:env.CLOUD_OWNER_EMAIL,password:env.CLOUD_OWNER_PASSWORD});
    const discovery=await (await fresh.call('active-source')).json();assert.equal(discovery.sourceId,state.sourceId);assert.equal(discovery.shared,true);
    const response=await fresh.call(`bootstrap&sourceId=${discovery.sourceId}&branchId=b1`);assert.equal(response.status,200);
    const bootstrap=await response.json() as Snapshot;assert.equal(bootstrap.user.role,'owner');assert.equal(bootstrap.orders[0].id,sale.order.id);assert.equal(bootstrap.inventory.find(row=>row.id==='b1-prepared-m1')!.quantity,48);
    assert.deepEqual(await f.store.get(state.sourceId),before);
    assert.doesNotMatch(JSON.stringify(bootstrap),/"pin"|"salt"|"hash"|"token"|"credentials"/);
    await fresh.call('logout',{});
    assert.equal((await fresh.call(`bootstrap&sourceId=${state.sourceId}`)).status,401);
    assert.deepEqual(await f.store.get(state.sourceId),before);
  }finally{await f.close();}
});

test('cloud discovery skips incomplete or revoked sources and requires a choice between valid shared workspaces',async()=>{
  const f=await fixture();try{
    await connectDeviceToCloud({email:env.CLOUD_OWNER_EMAIL,password:env.CLOUD_OWNER_PASSWORD,deviceName:'First shop'},{db:f.db,fetch:f.request});
    const state=(await syncDeviceCloud({db:f.db,fetch:f.request}))!;
    const original=(await f.store.get(state.sourceId))!;
    const empty=structuredClone(original);empty.source={...empty.source,sourceId:'empty-old-auto-source',shared:true};empty.records={};empty.metadata={};
    assert.equal(await f.store.replace(empty.source.sourceId,null,empty),true);
    assert.deepEqual(await (await f.call('active-source')).json(),{sourceId:null,shared:false,selectionRequired:false});
    await f.call('promote',{sourceId:state.sourceId});
    assert.equal((await (await f.call('active-source')).json()).sourceId,state.sourceId);
    const second=structuredClone((await f.store.get(state.sourceId))!);second.source.sourceId='second-shared-workspace';
    assert.equal(await f.store.replace(second.source.sourceId,null,second),true);
    assert.deepEqual(await (await f.call('active-source')).json(),{sourceId:null,shared:false,selectionRequired:true});
    await f.call('revoke',{sourceId:second.source.sourceId});
    assert.equal((await (await f.call('active-source')).json()).sourceId,state.sourceId);
  }finally{await f.close();}
});

test('device uploads enforce ordered packets and exact replay before changing cloud records',async()=>{
  const f=await fixture();try{
    await f.call('login',{email:env.CLOUD_OWNER_EMAIL,password:env.CLOUD_OWNER_PASSWORD});
    const enrollment=await (await f.call('enroll',{sourceId:'ordered-packets',workspaceId:'workspace-test',businessName:'Ordered shop',deviceName:'Counter'})).json();
    const headers={Authorization:`Bearer ${enrollment.token}`};
    const packet={sourceId:enrollment.sourceId,epoch:enrollment.epoch,sequence:1,eventId:'first-packet',ready:false,changes:[{kind:'customer',id:'guest',branchId:null,value:{id:'guest',name:'Original customer'}}]};
    const before=(await f.store.get(enrollment.sourceId))!;
    assert.equal((await f.call('push',{...packet,sequence:2},headers)).status,409);assert.deepEqual(await f.store.get(enrollment.sourceId),before);
    assert.equal((await f.call('push',packet,headers)).status,200);const after=(await f.store.get(enrollment.sourceId))!;
    assert.equal((await f.call('push',packet,headers)).status,200);assert.deepEqual(await f.store.get(enrollment.sourceId),after);
    assert.equal((await f.call('push',{...packet,ready:true},headers)).status,409);
    assert.equal((await f.call('push',{...packet,eventId:'out-of-order-event'},headers)).status,409);assert.deepEqual(await f.store.get(enrollment.sourceId),after);
    assert.equal((await f.call(`snapshot&sourceId=${enrollment.sourceId}`)).status,409);
    assert.equal((await f.call('push',{...packet,sequence:2,eventId:'baseline-finished',ready:true},headers)).status,200);
    assert.equal((await f.call('push',{...packet,sequence:3,eventId:'later-packet',ready:false},headers)).status,200);
    assert.equal((await f.store.get(enrollment.sourceId))!.source.ready,true);
  }finally{await f.close();}
});

test('cloud responses never expose internal service-account errors or raw error details',async()=>{
  const privateDetail='PRIVATE-KEY-DATA-FROM-FAILED-CONNECTION';
  const store=new MemoryMonitorStore();store.list=async()=>{throw Object.assign(new Error(privateDetail),{code:'INTERNAL_PROVIDER_DETAIL'});};
  const handler=createMonitorHandler({store,env});
  const login=await handler(new Request('https://pos.test/api/cloud?action=login',{method:'POST',headers:{Origin:'https://pos.test','Content-Type':'application/json'},body:JSON.stringify({email:env.CLOUD_OWNER_EMAIL,password:env.CLOUD_OWNER_PASSWORD})}));
  const cookie=login.headers.get('set-cookie')!.split(';')[0];
  for(const action of ['sources','active-source']){
    const response=await handler(new Request(`https://pos.test/api/cloud?action=${action}`,{headers:{Cookie:cookie}}));
    assert.equal(response.status,500);const body=await response.json();assert.equal(body.code,'CLOUD_ERROR');assert.equal(body.details,undefined);assert.doesNotMatch(JSON.stringify(body),new RegExp(privateDetail+'|INTERNAL_PROVIDER_DETAIL'));
  }
});

