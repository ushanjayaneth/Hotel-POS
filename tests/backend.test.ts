import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app';
import type { Snapshot, Order } from '../shared/types';
import { createCloudApp, firebasePersistence, type CloudEvent } from '../server/cloud';
import type { Database } from 'firebase-admin/database';

const cid=()=>randomUUID();
async function login(app:Awaited<ReturnType<typeof createApp>>,pin='1234') {
  const result=await app.inject({method:'POST',url:'/api/login',payload:{pin}});
  assert.equal(result.statusCode,200,result.body);
  return {cookie:result.cookies.map(x=>`${x.name}=${x.value}`).join('; ')};
}

test('durable order and payment commands are replay-safe; prices and stock come from the hub',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'ember-pos-'));const path=join(directory,'hub.sqlite');
  let app=await createApp({databasePath:path,seed:true});
  try {
    let headers=await login(app);
    const before=(await app.inject({url:'/api/bootstrap?branchId=b1',headers})).json<Snapshot>();
    const initialStock=before.inventory.find(x=>x.menuItemId==='m1')!.quantity;
    const create={commandId:cid(),branchId:'b1',type:'takeaway',lines:[{menuItemId:'m1',quantity:2,note:'No chilli'}]};
    const first=await app.inject({method:'POST',url:'/api/orders',headers,payload:create});assert.equal(first.statusCode,200,first.body);const order=first.json<{order:Order}>().order;assert.equal(order.total,130000);
    const replay=await app.inject({method:'POST',url:'/api/orders',headers,payload:create});assert.deepEqual(replay.json(),first.json());
    const after=(await app.inject({url:'/api/bootstrap?branchId=b1',headers})).json<Snapshot>();assert.equal(after.inventory.find(x=>x.menuItemId==='m1')!.quantity,initialStock-2);
    const changed=await app.inject({method:'POST',url:'/api/orders',headers,payload:{...create,lines:[{menuItemId:'m1',quantity:3}]}});assert.equal(changed.statusCode,409);
    const pay={commandId:cid(),expectedVersion:order.version,method:'cash',amount:order.total,received:150000};
    const payment=await app.inject({method:'POST',url:`/api/orders/${order.id}/payments`,headers,payload:pay});assert.equal(payment.statusCode,200,payment.body);assert.equal(payment.json().order.payments[0].change,20000);assert.equal(payment.json().order.status,'new');
    const paymentReplay=await app.inject({method:'POST',url:`/api/orders/${order.id}/payments`,headers,payload:pay});assert.deepEqual(paymentReplay.json(),payment.json());
    const expected=before.shifts.find(x=>x.status==='open')!.expectedCash+130000;
    assert.equal((await app.inject({url:'/api/bootstrap',headers})).json<Snapshot>().shifts.find(x=>x.status==='open')!.expectedCash,expected);
    await app.close();app=await createApp({databasePath:path,seed:true});headers=await login(app);
    const restoredReplay=await app.inject({method:'POST',url:`/api/orders/${order.id}/payments`,headers,payload:pay});assert.deepEqual(restoredReplay.json(),payment.json());
    const persisted=(await app.inject({url:'/api/bootstrap',headers})).json<Snapshot>();assert.equal(persisted.orders.find(x=>x.id===order.id)!.payments.length,1);assert.ok(persisted.sync.pending>=2);assert.equal(persisted.sync.configured,false);
    let current=persisted.orders.find(x=>x.id===order.id)!;
    for(const status of ['preparing','ready','served']){const result=await app.inject({method:'PATCH',url:`/api/orders/${order.id}/status`,headers,payload:{commandId:cid(),expectedVersion:current.version,status}});assert.equal(result.statusCode,200,result.body);current=result.json().order;assert.equal(current.status,status==='served'?'completed':status);}
  }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});

test('transactions roll back all stock on failure; stale devices cannot mutate an order',async()=>{
  const app=await createApp({databasePath:':memory:',seed:true});
  try {
    const headers=await login(app);const initial=(await app.inject({url:'/api/bootstrap',headers})).json<Snapshot>();const stock=initial.inventory.find(x=>x.menuItemId==='m1')!;
    const fail=await app.inject({method:'POST',url:'/api/orders',headers,payload:{commandId:cid(),branchId:'b1',type:'takeaway',lines:[{menuItemId:'m1',quantity:1},{menuItemId:'m2',quantity:1000}]}});assert.equal(fail.statusCode,409);
    const after=(await app.inject({url:'/api/bootstrap',headers})).json<Snapshot>();assert.equal(after.inventory.find(x=>x.id===stock.id)!.quantity,stock.quantity);assert.equal(after.orders.length,initial.orders.length);
    const fresh=initial.orders.find(x=>x.status==='new')!;const commandId=cid();const start=await app.inject({method:'PATCH',url:`/api/orders/${fresh.id}/status`,headers,payload:{commandId,expectedVersion:1,status:'preparing'}});assert.equal(start.statusCode,200,start.body);
    const stale=await app.inject({method:'PATCH',url:`/api/orders/${fresh.id}/status`,headers,payload:{commandId:cid(),expectedVersion:1,status:'preparing'}});assert.equal(stale.statusCode,409);assert.equal(stale.json().code,'VERSION_CONFLICT');
    const duplicate=await app.inject({method:'PATCH',url:`/api/orders/${fresh.id}/status`,headers,payload:{commandId,expectedVersion:1,status:'preparing'}});assert.equal(duplicate.statusCode,200);assert.equal(duplicate.json().order.version,2);
    const overpay=await app.inject({method:'POST',url:`/api/orders/${fresh.id}/payments`,headers,payload:{commandId:cid(),expectedVersion:2,method:'cash',amount:fresh.total+1,received:fresh.total+1}});assert.equal(overpay.statusCode,409);
    const noPayment=await app.inject({method:'POST',url:`/api/orders/${fresh.id}/refunds`,headers,payload:{commandId:cid(),expectedVersion:2,amount:1,reason:'Not paid'}});assert.equal(noPayment.statusCode,400);
  }finally{await app.close();}
});

test('roles and branch access are enforced on the server, including exports and settings',async()=>{
  const app=await createApp({databasePath:':memory:',seed:true});
  try {
    assert.equal((await app.inject({url:'/api/bootstrap'})).statusCode,401);
    const cashier=await login(app,'2222');const kitchen=await login(app,'4444');
    assert.equal((await app.inject({url:'/api/bootstrap?branchId=b2',headers:cashier})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/orders',headers:cashier,payload:{commandId:cid(),branchId:'b2',type:'takeaway',lines:[{menuItemId:'m1',quantity:1}]}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/backups',headers:cashier})).statusCode,403);
    assert.equal((await app.inject({method:'PUT',url:'/api/settings',headers:cashier,payload:{taxRate:20}})).statusCode,403);
    const kitchenState=(await app.inject({url:'/api/bootstrap',headers:kitchen})).json<Snapshot>();assert.equal(kitchenState.staff.length,0);assert.equal(kitchenState.expenses.length,0);assert.equal(kitchenState.customers.length,0);assert.equal(kitchenState.suppliers.length,0);assert.ok(kitchenState.orders.every(x=>x.total===0&&x.payments.length===0));assert.ok(kitchenState.menu.every(x=>x.cost===0));assert.ok(kitchenState.inventory.every(x=>x.unitCost===0));
    const newKitchenOrder=kitchenState.orders.find(x=>x.status==='new')!;const changed=await app.inject({method:'PATCH',url:`/api/orders/${newKitchenOrder.id}/status`,headers:kitchen,payload:{commandId:cid(),expectedVersion:newKitchenOrder.version,status:'preparing'}});assert.equal(changed.statusCode,200);assert.equal(changed.json().order.total,0);assert.equal(changed.json().order.payments.length,0);
    assert.equal((await app.inject({method:'POST',url:`/api/orders/${kitchenState.orders[0].id}/payments`,headers:kitchen,payload:{commandId:cid(),expectedVersion:1,method:'cash',amount:1}})).statusCode,403);
    const owner=await login(app);assert.equal((await app.inject({method:'POST',url:'/api/customers',headers:{...owner,origin:'https://malicious.example'},payload:{name:'Attacker',phone:'0771234567'}})).statusCode,403);
  }finally{await app.close();}
});

test('verified backups restore business records and command deduplication',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'ember-backup-'));let app=await createApp({databasePath:join(directory,'hub.sqlite'),seed:true});
  try {
    const headers=await login(app);const body={commandId:cid(),branchId:'b1',itemId:'b1-rice',quantity:3,reason:'Verified goods count'};
    const commandResult=await app.inject({method:'POST',url:'/api/inventory/adjust',headers,payload:body});assert.equal(commandResult.statusCode,200);
    const before=(await app.inject({url:'/api/bootstrap',headers})).json<Snapshot>();
    const backupResult=await app.inject({method:'POST',url:'/api/backups',headers});assert.equal(backupResult.statusCode,200,backupResult.body);const filename=backupResult.json().filename;
    assert.equal((await app.inject({url:`/api/backups/${filename}`,headers})).statusCode,200);
    await app.close();copyFileSync(join(directory,'backups',filename),join(directory,'restored.sqlite'));app=await createApp({databasePath:join(directory,'restored.sqlite'),seed:true});
    const restoredHeaders=await login(app);const retry=await app.inject({method:'POST',url:'/api/inventory/adjust',headers:restoredHeaders,payload:body});assert.equal(retry.statusCode,200);
    const restored=(await app.inject({url:'/api/bootstrap',headers:restoredHeaders})).json<Snapshot>();assert.equal(restored.inventory.find(x=>x.id==='b1-rice')!.quantity,before.inventory.find(x=>x.id==='b1-rice')!.quantity);assert.equal(restored.orders.length,before.orders.length);
  }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});

test('production and goods receipts reconcile portions, ingredients, supplier debt, and retries',async()=>{
  const app=await createApp({databasePath:':memory:',seed:true});
  try {
    const headers=await login(app);const before=(await app.inject({url:'/api/bootstrap',headers})).json<Snapshot>();
    const produce={commandId:cid(),branchId:'b1',menuItemId:'m1',quantity:3,note:'Afternoon preparation'};
    const result=await app.inject({method:'POST',url:'/api/production',headers,payload:produce});assert.equal(result.statusCode,200,result.body);
    assert.equal((await app.inject({method:'POST',url:'/api/production',headers,payload:produce})).statusCode,200);
    const produced=(await app.inject({url:'/api/bootstrap',headers})).json<Snapshot>();
    assert.equal(produced.inventory.find(x=>x.menuItemId==='m1')!.quantity,before.inventory.find(x=>x.menuItemId==='m1')!.quantity+3);
    assert.equal(produced.inventory.find(x=>x.id==='b1-rice')!.quantity,Math.round((before.inventory.find(x=>x.id==='b1-rice')!.quantity-.6)*10000)/10000);
    const invoice={commandId:cid(),branchId:'b1',supplierId:'s1',invoiceNumber:'TEST-INVOICE-1',lines:[{itemId:'b1-rice',quantity:5,unitCost:20000}]};
    const purchase=await app.inject({method:'POST',url:'/api/purchases',headers,payload:invoice});assert.equal(purchase.statusCode,200,purchase.body);
    assert.equal((await app.inject({method:'POST',url:'/api/purchases',headers,payload:invoice})).statusCode,200);
    const duplicate=await app.inject({method:'POST',url:'/api/purchases',headers,payload:{...invoice,commandId:cid()}});assert.equal(duplicate.statusCode,409);assert.equal(duplicate.json().code,'DUPLICATE_INVOICE');
    const received=(await app.inject({url:'/api/bootstrap',headers})).json<Snapshot>();assert.equal(received.suppliers.find(x=>x.id==='s1')!.balance,before.suppliers.find(x=>x.id==='s1')!.balance+100000);assert.equal(received.inventory.find(x=>x.id==='b1-rice')!.quantity,produced.inventory.find(x=>x.id==='b1-rice')!.quantity+5);
  }finally{await app.close();}
});

test('cash drawer guards and refunds preserve money totals without restocking cooked food',async()=>{
  const app=await createApp({databasePath:':memory:',seed:true});
  try {
    const headers=await login(app);const before=(await app.inject({url:'/api/bootstrap',headers})).json<Snapshot>();
    const orderResponse=await app.inject({method:'POST',url:'/api/orders',headers,payload:{commandId:cid(),branchId:'b1',type:'takeaway',lines:[{menuItemId:'m1',quantity:1}]}});assert.equal(orderResponse.statusCode,200);let order=orderResponse.json().order as Order;
    const firstPayment=await app.inject({method:'POST',url:`/api/orders/${order.id}/payments`,headers,payload:{commandId:cid(),expectedVersion:order.version,method:'cash',amount:30000,received:50000}});assert.equal(firstPayment.statusCode,200);order=firstPayment.json().order;
    const secondPayment=await app.inject({method:'POST',url:`/api/orders/${order.id}/payments`,headers,payload:{commandId:cid(),expectedVersion:order.version,method:'card',amount:35000}});assert.equal(secondPayment.statusCode,200);order=secondPayment.json().order;assert.equal(order.paymentStatus,'paid');
    const refund={commandId:cid(),expectedVersion:order.version,amount:30000,method:'cash',reason:'Guest returned the meal'};
    const refunded=await app.inject({method:'POST',url:`/api/orders/${order.id}/refunds`,headers,payload:refund});assert.equal(refunded.statusCode,200,refunded.body);assert.equal(refunded.json().order.refunded,30000);assert.equal((await app.inject({method:'POST',url:`/api/orders/${order.id}/refunds`,headers,payload:refund})).statusCode,200);
    const after=(await app.inject({url:'/api/bootstrap',headers})).json<Snapshot>();assert.equal(after.shifts[0].expectedCash,before.shifts[0].expectedCash);assert.equal(after.inventory.find(x=>x.menuItemId==='m1')!.quantity,before.inventory.find(x=>x.menuItemId==='m1')!.quantity-1);
    const close=await app.inject({method:'POST',url:`/api/shifts/${after.shifts[0].id}/close`,headers,payload:{commandId:cid(),countedCash:after.shifts[0].expectedCash-5000}});assert.equal(close.statusCode,200);assert.equal(close.json().shift.variance,-5000);
    const noShift=await app.inject({method:'POST',url:'/api/expenses',headers,payload:{commandId:cid(),branchId:'b1',category:'Utilities',description:'Water payment',amount:1000,paymentMethod:'cash'}});assert.equal(noShift.statusCode,409);assert.equal(noShift.json().code,'SHIFT_REQUIRED');
  }finally{await app.close();}
});

function fakeFirebase() {
  const tree:Record<string,any>={};
  const read=(path:string[])=>path.reduce<any>((node,key)=>node?.[key],tree)??null;
  const write=(path:string[],value:unknown)=>{let node=tree;for(const key of path.slice(0,-1))node=node[key]??={};node[path.at(-1)!]=structuredClone(value);};
  const reference=(path:string[])=>({child:(suffix:string)=>reference([...path,...suffix.split('/')]),transaction:async(update:(value:any)=>unknown)=>{const next=update(structuredClone(read(path)));if(next===undefined)return {committed:false,snapshot:{val:()=>read(path)}};write(path,next);return {committed:true,snapshot:{val:()=>read(path)}};},update:async(changes:Record<string,unknown>)=>write(path,{...read(path),...changes})});
  return {database:{ref:(path:string)=>reference(path.split('/'))} as unknown as Database,tree};
}

test('cloud receiver authenticates branches and durably applies canonical events exactly once, in either arrival order',async()=>{
  const fake=fakeFirebase();const token='a-strong-test-secret-with-more-than-thirty-two-characters';
  const app=await createCloudApp({credentials:{'test-hub':{branchId:'b1',token}},persistence:firebasePersistence(fake.database,'test-tenant')});
  const event=(sequence:number,quantity:number):CloudEvent=>({id:`event-${sequence}`,commandId:`command-${sequence}`,branchId:'b1',sequence,action:'inventory.adjust',actor:'staff-owner',createdAt:new Date().toISOString(),changes:[{kind:'inventory',id:'b1-rice',branchId:'b1',value:{id:'b1-rice',branchId:'b1',quantity}}]});
  const headers={authorization:`Bearer ${token}`};const latest=event(2,20);const earlier=event(1,10);
  // Multiple order lines may consume the same ingredient in one atomic command.
  latest.changes.unshift({...latest.changes[0],value:{id:'b1-rice',branchId:'b1',quantity:19}});
  try {
    assert.equal((await app.inject({method:'POST',url:'/api/ingest',payload:{hubId:'test-hub',events:[latest]}})).statusCode,401);
    const unauthorized=await app.inject({method:'POST',url:'/api/ingest',headers,payload:{hubId:'test-hub',events:[{...latest,branchId:'b2'}]}});assert.equal(unauthorized.statusCode,403);
    const applied=await app.inject({method:'POST',url:'/api/ingest',headers,payload:{hubId:'test-hub',events:[latest]}});assert.equal(applied.statusCode,200,applied.body);assert.deepEqual(applied.json().acceptedIds,[latest.id]);
    assert.equal((await app.inject({method:'POST',url:'/api/ingest',headers,payload:{hubId:'test-hub',events:[earlier]}})).statusCode,200);
    const reordered=Object.fromEntries(Object.entries(latest).reverse());assert.equal((await app.inject({method:'POST',url:'/api/ingest',headers,payload:{hubId:'test-hub',events:[reordered]}})).statusCode,200);
    const branch=fake.tree.tenants['test-tenant'].branches.b1;assert.equal(branch.projection.records.inventory['b1-rice'].value.quantity,20);assert.equal(Object.keys(branch.events).length,2);assert.equal(branch.events[latest.id].status,'applied');
    const altered=structuredClone(latest);altered.changes[0].value.quantity=21;const conflict=await app.inject({method:'POST',url:'/api/ingest',headers,payload:{hubId:'test-hub',events:[altered]}});assert.equal(conflict.statusCode,409);assert.equal(conflict.json().code,'EVENT_CONFLICT');
    const reusedSequence=await app.inject({method:'POST',url:'/api/ingest',headers,payload:{hubId:'test-hub',events:[{...latest,id:'event-restored-old-backup',commandId:'command-restored'}]}});assert.equal(reusedSequence.statusCode,409);assert.equal(reusedSequence.json().code,'SEQUENCE_CONFLICT');
  }finally{await app.close();}
});

test('cloud failures are never acknowledged; a configured baseline includes existing branch data without authentication secrets',async()=>{
  const token='another-strong-test-secret-of-thirty-two-plus-characters';
  const failed=await createCloudApp({credentials:{hub:{branchId:'b1',token}},persistence:{apply:async()=>{throw new Error('Cloud storage unavailable');}}});
  const event:CloudEvent={id:'event-failed',commandId:'command-failed',branchId:'b1',sequence:1,action:'test',actor:'system',createdAt:new Date().toISOString(),changes:[]};
  try {const response=await failed.inject({method:'POST',url:'/api/ingest',headers:{authorization:`Bearer ${token}`},payload:{hubId:'hub',events:[event]}});assert.equal(response.statusCode,500);assert.equal(response.json().acceptedIds,undefined);}finally{await failed.close();}
  const hub=await createApp({databasePath:':memory:',seed:true});const firebase=fakeFirebase();const cloud=await createCloudApp({credentials:{hub:{branchId:'b1',token}},persistence:firebasePersistence(firebase.database,'baseline-test')});
  try {
    hub.store.queueBaseline('b1','hub','https://receiver.example/api/ingest');hub.store.queueBaseline('b1','hub','https://receiver.example/api/ingest');
    const rows=hub.store.db.prepare('SELECT payload FROM outbox ORDER BY rowid').all();assert.ok(rows.length>0);
    const events=rows.map(x=>JSON.parse(x.payload as string));const response=await cloud.inject({method:'POST',url:'/api/ingest',headers:{authorization:`Bearer ${token}`},payload:{hubId:'hub',events}});assert.equal(response.statusCode,200,response.body);
    const records=firebase.tree.tenants['baseline-test'].branches.b1.projection.records;assert.equal(Object.keys(records.menu).length,12);assert.equal(records.branch.b1.value.name,'Colombo');assert.ok(records.inventory['b1-rice']);assert.equal(Object.keys(records.order).length,12);assert.equal(records.settings.settings.value.businessName,'DEMO HOTEL');assert.equal(records.credentials,undefined);assert.equal(records.sessions,undefined);assert.equal(records.staff['staff-owner'].value.pin,undefined);
  }finally{await hub.close();await cloud.close();}
});
