import {test} from 'node:test';
import assert from 'node:assert/strict';
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
  const store=new MemoryMonitorStore(),handler=createMonitorHandler({store,env});let cookie='';let loseAck=false;
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
  const db=new LocalDatabase(`cloud-test-${crypto.randomUUID()}`);
  await initializeLocalWorkspace({businessName:'Cloud Test Hotel',ownerName:'Test Owner',pin:'98765432',demo:true},db);
  return {store,handler,request,call,db,loseNextAck:()=>{loseAck=true;},close:()=>db.delete()};
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

test('shared cloud confirms concurrent stock once, replays commands once and rejects old independent uploads',async()=>{
  const f=await fixture();try{
    await connectDeviceToCloud({email:env.CLOUD_OWNER_EMAIL,password:env.CLOUD_OWNER_PASSWORD,deviceName:'Main shop'},{db:f.db,fetch:f.request});
    const state=(await syncDeviceCloud({db:f.db,fetch:f.request}))!;const sourceId=state.sourceId;
    assert.equal((await f.call('promote',{sourceId})).status,200);
    assert.equal((await syncDeviceCloud({db:f.db,fetch:f.request}))!.shared,true);
    const projection=(await f.store.get(sourceId))!;const stock=projection.records[recordKey('inventory','b1-prepared-m1')];(stock.value as unknown as InventoryItem).quantity=1;
    projection.revision++;await f.store.replace(sourceId,projection.revision-1,projection);
    const command=(commandId:string)=>({sourceId,path:'/orders',method:'POST',body:{commandId,branchId:'b1',type:'takeaway',lines:[{menuItemId:'m1',quantity:1}]}});
    const [a,b]=await Promise.all([f.call('command',command('shared-order-command-a')),f.call('command',command('shared-order-command-b'))]);
    assert.deepEqual([a.status,b.status].sort(),[200,409]);
    const winner=a.status===200?'shared-order-command-a':'shared-order-command-b';
    const replay=await f.call('command',command(winner));assert.equal(replay.status,200);
    const result=await f.store.get(sourceId);assert.equal((result!.records[recordKey('inventory','b1-prepared-m1')].value as unknown as InventoryItem).quantity,0);
    assert.equal(Object.values(result!.records).filter(row=>row.kind==='order').length,1);
    assert.equal((await f.call('command',{...command(winner),body:{...command(winner).body,note:'Changed replay'}})).status,409);
    const bootstrap=await (await f.call(`bootstrap&sourceId=${sourceId}&branchId=b1`)).json() as Snapshot;assert.equal(bootstrap.orders.length,1);
    assert.equal((await f.call('command',{sourceId,path:'/staff',method:'POST',body:{commandId:'blocked-staff-command'}})).status,403);
  }finally{await f.close();}
});

test('cloud packet sizes are bounded and credential tables/media never enter monitoring records',()=>{
  const rows=monitoringChanges([{kind:'credentials',id:'private',branchId:null,value:{hash:'private'}},{kind:'media',id:'photo',branchId:null,value:{data:'bytes'}},{kind:'customer',id:'c1',branchId:null,value:{id:'c1',name:'Name',password:'private'}}]);
  assert.equal(rows.length,1);assert.equal(rows[0].value.password,undefined);
  const records:Array<CloudChange>=Array.from({length:251},(_,index)=>({kind:'customer',id:`c${index}`,branchId:null,value:{id:`c${index}`,name:'a'.repeat(1000)}}));
  const chunks=cloudChunks(records,50000);assert.equal(chunks.flat().length,251);assert.ok(chunks.every(chunk=>Buffer.byteLength(JSON.stringify(chunk))<50000));
});
