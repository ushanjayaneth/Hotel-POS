import 'fake-indexeddb/auto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Customer,Order,Snapshot,User} from '../shared/types';
import type {OfflineCloudState} from '../shared/offline-cloud';
import {createApp} from '../server/app';
import {LocalDatabase,LocalStore} from '../src/lib/local/db';
import {Store} from '../server/database';
import {createLocalApi,initializeLocalWorkspace} from '../src/lib/local/core';
import {forgetLocalSession} from '../src/lib/local/auth';
import {createMonitorHandler} from '../server/monitor/handler';
import {MemoryMonitorStore} from '../server/monitor/store';
import {CloudOfflineReplica,type OfflineCloudRequest} from '../src/lib/cloud-offline';
import {openAutomaticCloudWorkspace} from '../src/lib/cloud-sync';

const id=()=>randomUUID();
const rejected=(expected:number)=>(error:unknown)=>Boolean(error&&typeof error==='object'&&'status'in error&&error.status===expected);
async function fixture(mode:'hub'|'device'){
  const app=mode==='hub'?await createApp({databasePath:':memory:',seed:true}):undefined;
  const db=mode==='device'?new LocalDatabase(`split-loan-${id()}`):undefined;
  if(db)await initializeLocalWorkspace({businessName:'Split Loan Test',ownerName:'Owner',pin:'98765432',demo:true},db);
  const local=db?createLocalApi(db):undefined;
  const store=app?(app as unknown as {store:Store}).store:new LocalStore(db!);
  let headers:Record<string,string>={};
  const login=async(pin:string)=>{if(local){await local('/logout',{});await local('/login',{pin});}else{const response=await app!.inject({method:'POST',url:'/api/login',payload:{pin}});assert.equal(response.statusCode,200,response.body);headers={cookie:response.cookies[0].name+'='+response.cookies[0].value};}};
  if(app)await login('1234');
  const api=async<T=any>(path:string,body?:unknown):Promise<T>=>{
    if(local)return local<T>(path,body);
    const response=await app!.inject({method:body===undefined?'GET':'POST',url:'/api'+path,headers,...(body===undefined?{}:{payload:body as any})});
    if(response.statusCode>=400)throw Object.assign(new Error(response.body),{status:response.statusCode});
    return response.json<T>();
  };
  let customerSequence=0;
  const customer=async(name='Split Customer')=>(await api<{customer:Customer}>('/customers',{commandId:id(),name,phone:`07712345${String(customerSequence++).padStart(2,'0')}`})).customer;
  const order=async(customerId?:string)=>(await api<{order:Order}>('/orders',{commandId:id(),branchId:'b1',type:'takeaway',customerId,lines:[{menuItemId:'m1',quantity:1}]})).order;
  const state=()=>api<Snapshot>('/bootstrap?branchId=b1');
  return{api,db,store,login,customer,order,state,destroy:async()=>{if(app)await app.close();if(db){forgetLocalSession(db);await db.delete();}}};
}
const split=(order:Order,customerId:string,extra:Record<string,unknown>={})=>({commandId:id(),expectedVersion:order.version,method:'credit',customerId,amount:order.total-order.paid,received:order.total-order.paid,cashAmount:20000,...extra});
const openCash=(snapshot:Snapshot)=>snapshot.shifts.find(row=>row.status==='open')!.expectedCash;

for(const mode of ['hub','device'] as const){
  test(`${mode}: one cash-and-loan command settles the bill, adds only the remainder to dues and replays exactly once`,async()=>{
    const f=await fixture(mode);
    try{
      const customer=await f.customer(),order=await f.order();assert.equal(order.total,65000);
      const before=await f.state(),command=split(order,customer.id);
      const paid=await f.api<{order:Order}>(`/orders/${order.id}/payments`,command);
      assert.equal(paid.order.paid,65000);assert.equal(paid.order.version,order.version+1);assert.equal(paid.order.paymentStatus,'paid');
      assert.deepEqual(paid.order.payments.map(payment=>({method:payment.method,amount:payment.amount,received:payment.received,change:payment.change})),[{method:'cash',amount:20000,received:20000,change:0},{method:'credit',amount:45000,received:45000,change:0}]);
      const after=await f.state(),saved=after.customers.find(row=>row.id===customer.id)!;
      assert.equal(openCash(after),openCash(before)+20000);assert.equal(saved.balance,45000);assert.equal(saved.spent,65000);assert.equal(saved.visits,1);
      assert.deepEqual(after.inventory,before.inventory);
      assert.deepEqual(after.creditEntries.filter(row=>row.orderId===order.id).map(row=>({type:row.type,amount:row.amount,method:row.method})),[{type:'sale',amount:45000,method:'credit'}]);
      assert.deepEqual(await f.api(`/orders/${order.id}/payments`,command),paid);
      const replay=await f.state();assert.deepEqual(replay.orders,after.orders);assert.deepEqual(replay.customers,after.customers);assert.deepEqual(replay.creditEntries,after.creditEntries);assert.deepEqual(replay.shifts,after.shifts);
      await f.api(`/customers/${customer.id}/collections`,{commandId:id(),branchId:'b1',amount:10000,method:'cash'});
      await f.api(`/customers/${customer.id}/collections`,{commandId:id(),branchId:'b1',amount:35000,method:'cash'});
      const collected=await f.state();assert.equal(collected.customers.find(row=>row.id===customer.id)!.balance,0);assert.equal(openCash(collected),openCash(before)+65000);
      assert.equal(collected.customers.find(row=>row.id===customer.id)!.spent,65000);assert.equal(collected.orders.find(row=>row.id===order.id)!.payments.length,2);
    }finally{await f.destroy();}
  });

  test(`${mode}: invalid split payments and customer reassignment reject without partial cash, debt or payment records`,async()=>{
    const f=await fixture(mode);
    try{
      const customer=await f.customer(),other=await f.customer('Other Customer'),order=await f.order();
      const unchanged=async(command:Record<string,unknown>,status:number)=>{const before=await f.state();await assert.rejects(f.api(`/orders/${order.id}/payments`,command),rejected(status));const after=await f.state();for(const key of ['orders','customers','creditEntries','shifts','inventory'] as const)assert.deepEqual(after[key],before[key]);};
      for(const cashAmount of [-1,0.5,65000,65001])await unchanged(split(order,customer.id,{cashAmount}),400);
      await unchanged(split(order,customer.id,{customerId:undefined}),400);
      await unchanged(split(order,customer.id,{customerId:'missing-customer'}),404);
      await unchanged(split(order,customer.id,{method:'cash'}),400);
      await unchanged(split(order,customer.id,{received:20000}),400);
      await unchanged(split(order,customer.id,{expectedVersion:order.version+1}),409);
      const partial=(await f.api<{order:Order}>(`/orders/${order.id}/payments`,split(order,customer.id,{amount:30000,received:30000,cashAmount:10000}))).order;
      const before=await f.state();await assert.rejects(f.api(`/orders/${order.id}/payments`,split(partial,other.id,{cashAmount:10000})),rejected(409));
      const after=await f.state();for(const key of ['orders','customers','creditEntries','shifts','inventory'] as const)assert.deepEqual(after[key],before[key]);
    }finally{await f.destroy();}
  });

  test(`${mode}: split-payment cash refunds affect the drawer and credit refunds affect only the loan`,async()=>{
    const f=await fixture(mode);
    try{
      const customer=await f.customer(),order=await f.order(customer.id),before=await f.state();
      let paid=(await f.api<{order:Order}>(`/orders/${order.id}/payments`,split(order,customer.id))).order;
      paid=(await f.api<{order:Order}>(`/orders/${order.id}/refunds`,{commandId:id(),expectedVersion:paid.version,amount:10000,method:'credit',reason:'Return credit portion'})).order;
      let snapshot=await f.state();assert.equal(snapshot.customers.find(row=>row.id===customer.id)!.balance,35000);assert.equal(openCash(snapshot),openCash(before)+20000);
      await f.api(`/orders/${order.id}/refunds`,{commandId:id(),expectedVersion:paid.version,amount:5000,method:'cash',reason:'Return cash portion'});
      snapshot=await f.state();assert.equal(snapshot.customers.find(row=>row.id===customer.id)!.balance,35000);assert.equal(openCash(snapshot),openCash(before)+15000);
    }finally{await f.destroy();}
  });

  test(`${mode}: a cash-and-loan command cannot bypass cashier branch scope or kitchen role restrictions`,async()=>{
    const f=await fixture(mode);
    try{
      const customer=await f.customer(),order=await f.order(),other={...order,id:id(),branchId:'b2'};
      if(f.db){
        await f.store.put('branch',{id:'b2',name:'Other branch',nameSi:'Other branch',code:'OTHER',address:'',phone:''});
        await f.api('/staff',{commandId:id(),name:'Scoped Cashier',role:'cashier',branchId:'b1',pin:'456789',phone:''});
        await f.api('/staff',{commandId:id(),name:'Scoped Kitchen',role:'kitchen',branchId:'b1',pin:'567890',phone:''});
      }
      await f.store.put('order',other);
      await f.login(f.db?'456789':'2222');
      await assert.rejects(f.api(`/orders/${other.id}/payments`,split(other,customer.id)),rejected(403));
      await f.login(f.db?'567890':'4444');
      await assert.rejects(f.api(`/orders/${order.id}/payments`,split(order,customer.id)),rejected(403));
      assert.deepEqual(await f.store.get<Order>('order',order.id),order);assert.deepEqual(await f.store.get<Order>('order',other.id),other);
    }finally{await f.destroy();}
  });
}

test('device: a storage error after the order and drawer changes rolls the entire split payment back',async()=>{
  const f=await fixture('device');
  const fail=(_key:unknown,row:{kind:string})=>{if(row.kind==='credit')throw new DOMException('Storage quota exceeded','QuotaExceededError');};
  try{
    const customer=await f.customer(),order=await f.order(),before=await f.state();
    const command=split(order,customer.id),commands=await f.db!.commands.count(),journal=await f.db!.journal.count();
    f.db!.records.hook('creating',fail);
    await assert.rejects(f.api(`/orders/${order.id}/payments`,command));f.db!.records.hook('creating').unsubscribe(fail);
    const after=await f.state();for(const key of ['orders','customers','creditEntries','shifts','inventory'] as const)assert.deepEqual(after[key],before[key]);
    assert.equal(await f.db!.commands.count(),commands);assert.equal(await f.db!.journal.count(),journal);
    assert.equal((await f.api<{order:Order}>(`/orders/${order.id}/payments`,command)).order.payments.length,2);
  }finally{f.db!.records.hook('creating').unsubscribe(fail);await f.destroy();}
});

test('cloud: a durable offline split sale reconciles both payments once after a lost acknowledgement',async()=>{
  const original=new LocalDatabase(`split-cloud-original-${id()}`),db=new LocalDatabase(`split-cloud-device-${id()}`);
  try{
    await initializeLocalWorkspace({businessName:'Split Cloud',ownerName:'Owner',pin:'98765432',demo:true},original);
    const store=new MemoryMonitorStore(),handler=createMonitorHandler({store,env:{CLOUD_POS_PIN:'98765432',CLOUD_SESSION_SECRET:'s'.repeat(64)}});let cookie='';
    const fetcher:typeof fetch=async(input,init)=>{const url=new URL(String(input),'https://split.test'),headers=new Headers(init?.headers);headers.set('Origin',url.origin);if(cookie)headers.set('Cookie',cookie);const result=await handler(new Request(url,{...init,headers}));if(result.headers.has('set-cookie'))cookie=result.headers.get('set-cookie')!.split(';')[0];return result;};
    const call:OfflineCloudRequest=async<T>(action:string,body?:unknown)=>{const response=await fetcher(`/api/cloud?action=${action}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error),{status:response.status,code:data.code});return data as T;};
    await call('pos-login',{pin:'98765432'});const sourceId=(await openAutomaticCloudWorkspace({db:original,fetch:fetcher}))!;
    const owner:User={id:'cloud-owner',name:'Administrator',initials:'A',role:'owner',branchId:null};
    const cached=await call<Snapshot&{offlineState:OfflineCloudState}>(`bootstrap&sourceId=${sourceId}&includeOffline=1`),replica=new CloudOfflineReplica(sourceId,db);await replica.cache(cached.offlineState,owner);
    const customer=(await replica.api<{customer:Customer}>('/customers',{commandId:id(),name:'Offline Split Guest',phone:'0771112222'},'POST',{offline:true})).customer;
    const order=(await replica.api<{order:Order}>('/orders',{commandId:id(),branchId:'b1',type:'takeaway',lines:[{menuItemId:'m1',quantity:1}]},'POST',{offline:true})).order;
    const command=split(order,customer.id);const paid=await replica.api<{order:Order}>(`/orders/${order.id}/payments`,command,'POST',{offline:true});assert.equal(paid.order.payments.length,2);
    db.close();await db.open();const reopened=new CloudOfflineReplica(sourceId,db);assert.deepEqual(await reopened.api(`/orders/${order.id}/payments`,command,'POST',{offline:true}),paid);
    let dropped=false;const lossy:OfflineCloudRequest=async<T>(action:string,body?:unknown)=>{const result=await call<T>(action,body);if((body as {transactionId?:string})?.transactionId===command.commandId&&!dropped){dropped=true;throw new TypeError('Connection dropped after cloud accepted split payment');}return result;};
    assert.equal((await reopened.sync(lossy)).pending,1);assert.equal((await reopened.sync(call)).pending,0);
    const restored=await call<Snapshot>(`bootstrap&sourceId=${sourceId}`),saved=restored.orders.find(row=>row.id===order.id)!;
    assert.equal(saved.payments.length,2);assert.equal(saved.paid,65000);assert.equal(restored.customers.find(row=>row.id===customer.id)!.balance,45000);
    assert.equal(openCash(restored),openCash(cached)+20000);assert.equal(restored.creditEntries.filter(row=>row.orderId===order.id).length,1);
    assert.equal(restored.inventory.find(row=>row.id==='b1-prepared-m1')!.quantity,49);
  }finally{await db.delete();await original.delete();}
});
