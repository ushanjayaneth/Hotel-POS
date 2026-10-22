import 'fake-indexeddb/auto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Branch, CreditEntry, Customer, InventoryItem, Order, Shift, Snapshot} from '../shared/types';
import {createApp} from '../server/app';
import {Store} from '../server/database';
import {LocalDatabase, LocalStore} from '../src/lib/local/db';
import {createLocalApi, initializeLocalWorkspace} from '../src/lib/local/core';
import {forgetLocalSession} from '../src/lib/local/auth';

const cid=()=>randomUUID();
type Mode='hub'|'device';
const status=(expected:number)=>(error:unknown)=>Boolean(error&&typeof error==='object'&&'status'in error&&error.status===expected);

async function fixture(mode:Mode){
  const app=mode==='hub'?await createApp({databasePath:':memory:',seed:true}):undefined;
  const db=mode==='device'?new LocalDatabase(`customer-loan-${cid()}`):undefined;
  if(db)await initializeLocalWorkspace({businessName:'Loan restaurant',ownerName:'Owner User',pin:'987654',demo:true},db);
  const store=app?(app as unknown as {store:Store}).store:new LocalStore(db!);
  const local=db?createLocalApi(db):undefined;
  let headers:Record<string,string>={};
  const login=async(pin:string)=>{
    if(local){await local('/logout',{});await local('/login',{pin});}
    else {const response=await app!.inject({method:'POST',url:'/api/login',payload:{pin}});assert.equal(response.statusCode,200,response.body);headers={cookie:response.cookies[0].name+'='+response.cookies[0].value};}
  };
  if(app)await login('1234');
  const api=async<T=any>(path:string,body?:unknown,method?:string):Promise<T>=>{
    if(local)return local<T>(path,body,method);
    const response=await app!.inject({url:'/api'+path,method:(method??(body===undefined?'GET':'POST')) as 'GET'|'POST'|'PATCH'|'PUT'|'DELETE',headers,...(body===undefined?{}:{payload:body as any})});
    if(response.statusCode>=400)throw Object.assign(new Error(response.body),{status:response.statusCode});
    return response.json<T>();
  };
  const customer=async(name='Loan Customer',phone='0771234567')=>(await api<{customer:Customer}>('/customers',{commandId:cid(),name,phone})).customer;
  const create=async(customerId?:string)=>(await api<{order:Order}>('/orders',{commandId:cid(),branchId:'b1',type:'takeaway',customerId,lines:[{menuItemId:'m1',quantity:1}]})).order;
  const pay=async(order:Order,extra:Record<string,unknown>={})=>api<{order:Order}>(`/orders/${order.id}/payments`,{commandId:cid(),expectedVersion:order.version,method:'credit',amount:order.total-order.paid,...extra});
  const financialState=async()=>({orders:await store.list<Order>('order'),customers:await store.list<Customer>('customer'),credits:await store.list<CreditEntry>('credit'),inventory:await store.list<InventoryItem>('inventory'),shifts:await store.list<Shift>('shift')});
  const finish=async()=>{if(app)await app.close();if(db){forgetLocalSession(db);await db.delete();}};
  return{api,app,db,store,login,customer,create,pay,financialState,finish};
}

for(const mode of ['hub','device'] as const){
  test(`${mode}: a saved anonymous order can become a Customer Loan, with replay-safe stock and debt`,async()=>{
    const f=await fixture(mode);
    try{
      const order=await f.create();assert.equal(order.customerId,null);
      const before=await f.financialState();
      const customer=await f.customer();
      const command={commandId:cid(),expectedVersion:order.version,method:'credit',customerId:customer.id,amount:order.total};
      const result=await f.api<{order:Order}>(`/orders/${order.id}/payments`,command);
      assert.equal(result.order.customerId,customer.id);assert.equal(result.order.paymentStatus,'paid');assert.equal(result.order.status,'new');
      assert.equal(result.order.payments.length,1);assert.equal(result.order.payments[0].method,'credit');
      const paidState=await f.financialState();
      assert.deepEqual(paidState.inventory,before.inventory);assert.deepEqual(paidState.shifts,before.shifts);
      assert.equal(paidState.orders.length,before.orders.length);
      assert.deepEqual(paidState.credits.filter(row=>row.orderId===order.id).map(row=>[row.customerId,row.amount,row.type]),[[customer.id,order.total,'sale']]);
      assert.deepEqual(await f.api(`/orders/${order.id}/payments`,command),result);
      assert.deepEqual(await f.financialState(),paidState);
      await assert.rejects(f.api(`/orders/${order.id}/payments`,{...command,customerId:'another-customer'}),status(409));
      const next=await f.create();const second=await f.pay(next,{customerId:customer.id});
      assert.equal(second.order.customerId,customer.id);
      const state=await f.api<Snapshot>('/bootstrap');const saved=state.customers.find(row=>row.id===customer.id)!;
      assert.equal(saved.balance,order.total+next.total);assert.equal(saved.spent,order.total+next.total);assert.equal(saved.visits,2);
      assert.equal(state.creditEntries.filter(row=>row.customerId===customer.id).length,2);
      const collection={commandId:cid(),branchId:'b1',amount:20000,method:'cash'};
      const collected=await f.api(`/customers/${customer.id}/collections`,collection);
      assert.equal(collected.balance,order.total+next.total-20000);
      assert.deepEqual(await f.api(`/customers/${customer.id}/collections`,collection),collected);
      assert.equal((await f.api<Snapshot>('/bootstrap')).customers.find(row=>row.id===customer.id)!.balance,collected.balance);
    }finally{await f.finish();}
  });

  test(`${mode}: an unpaid order may change customer, then partial loans retain the bound account`,async()=>{
    const f=await fixture(mode);
    try{
      const original=await f.customer('Original Customer','0771111111');
      const chosen=await f.customer('Chosen Customer','0772222222');
      let order=await f.create(original.id);
      order=(await f.pay(order,{customerId:chosen.id,amount:20000})).order;
      assert.equal(order.customerId,chosen.id);assert.equal(order.paymentStatus,'partial');
      order=(await f.pay(order,{amount:10000})).order;
      order=(await f.pay(order,{customerId:chosen.id})).order;
      assert.equal(order.paymentStatus,'paid');assert.equal(order.payments.length,3);
      const state=await f.api<Snapshot>('/bootstrap');
      assert.equal(state.customers.find(row=>row.id===chosen.id)!.balance,order.total);
      assert.equal(state.customers.find(row=>row.id===original.id)!.balance,0);
      assert.equal(state.customers.find(row=>row.id===original.id)!.spent,0);
      assert.ok(state.creditEntries.filter(row=>row.orderId===order.id).every(row=>row.customerId===chosen.id));
    }finally{await f.finish();}
  });

  test(`${mode}: missing, invalid, stale and non-loan customer selections leave all financial records unchanged`,async()=>{
    const f=await fixture(mode);
    try{
      const customer=await f.customer();const order=await f.create();const before=await f.financialState();
      await assert.rejects(f.pay(order),status(400));
      await assert.rejects(f.pay(order,{customerId:'missing-customer'}),status(404));
      await assert.rejects(f.pay(order,{customerId:''}),status(400));
      await assert.rejects(f.pay(order,{customerId:null}),status(400));
      await assert.rejects(f.pay(order,{customerId:customer.id,expectedVersion:order.version+1}),status(409));
      await assert.rejects(f.pay(order,{customerId:customer.id,method:'cash'}),status(400));
      await assert.rejects(f.pay(order,{customerId:customer.id,method:'card',reference:'Terminal approval'}),status(400));
      assert.deepEqual(await f.financialState(),before);
      const retryId=cid();
      await assert.rejects(f.pay(order,{commandId:retryId,customerId:'missing-customer'}),status(404));
      const result=await f.pay(order,{commandId:retryId,customerId:customer.id});
      assert.equal(result.order.customerId,customer.id);
    }finally{await f.finish();}
  });

  test(`${mode}: a customer cannot be attached or reassigned after cash or loan payments`,async()=>{
    const f=await fixture(mode);
    try{
      const one=await f.customer('First Customer','0771111111'),two=await f.customer('Second Customer','0772222222');
      let anonymous=await f.create();anonymous=(await f.pay(anonymous,{method:'cash',amount:10000})).order;
      let before=await f.financialState();
      await assert.rejects(f.pay(anonymous,{customerId:one.id}),status(409));
      assert.deepEqual(await f.financialState(),before);
      let assigned=await f.create(one.id);assigned=(await f.pay(assigned,{method:'cash',amount:10000})).order;
      before=await f.financialState();await assert.rejects(f.pay(assigned,{customerId:two.id}),status(409));assert.deepEqual(await f.financialState(),before);
      assigned=(await f.pay(assigned,{customerId:one.id,amount:10000})).order;
      before=await f.financialState();await assert.rejects(f.pay(assigned,{customerId:two.id}),status(409));assert.deepEqual(await f.financialState(),before);
      assigned=(await f.pay(assigned)).order;
      const state=await f.api<Snapshot>('/bootstrap');assert.equal(state.customers.find(row=>row.id===one.id)!.balance,assigned.total-10000);
      assert.equal(state.customers.find(row=>row.id===two.id)!.balance,0);
    }finally{await f.finish();}
  });

  test(`${mode}: imported loan and refund history also locks the customer, even with zero payment counters`,async()=>{
    const f=await fixture(mode);
    try{
      const one=await f.customer('First Customer','0771111111'),two=await f.customer('Second Customer','0772222222');
      const order=await f.create(one.id);
      await f.store.put<CreditEntry>('credit',{id:cid(),branchId:order.branchId,customerId:one.id,orderId:order.id,type:'sale',amount:100,method:'credit',reference:'',note:'Imported history',createdAt:new Date().toISOString(),createdBy:'staff-owner'});
      let before=await f.financialState();await assert.rejects(f.pay(order,{customerId:two.id}),status(409));assert.deepEqual(await f.financialState(),before);
      const other=await f.create(one.id);
      await f.store.put('refund',{id:cid(),orderId:other.id,branchId:other.branchId,amount:100,method:'cash'});
      before=await f.financialState();await assert.rejects(f.pay(other,{customerId:two.id}),status(409));assert.deepEqual(await f.financialState(),before);
    }finally{await f.finish();}
  });

  test(`${mode}: Customer Loan selection preserves role, branch, shift and closed-order guards`,async()=>{
    const f=await fixture(mode);
    try{
      const customer=await f.customer();const order=await f.create();
      if(f.db){
        await f.api('/staff',{commandId:cid(),name:'Cashier User',role:'cashier',branchId:'b1',pin:'456789',phone:''});
        await f.api('/staff',{commandId:cid(),name:'Kitchen User',role:'kitchen',branchId:'b1',pin:'567890',phone:''});
        await f.store.put<Branch>('branch',{id:'b2',name:'Second branch',nameSi:'Second branch',code:'SEC',address:'',phone:''});
      }
      const otherBranch={...order,id:cid(),branchId:'b2'};await f.store.put('order',otherBranch);
      await f.login(f.db?'456789':'2222');
      await assert.rejects(f.pay(otherBranch,{customerId:customer.id}),status(403));
      const first=(await f.pay(order,{customerId:customer.id,amount:10000})).order;assert.equal(first.customerId,customer.id);
      await f.login(f.db?'567890':'4444');
      await assert.rejects(f.pay(first,{customerId:customer.id}),status(403));
      await f.login(f.db?'987654':'1234');
      const closed={...first,status:'completed' as const};await f.store.put('order',closed);
      await assert.rejects(f.pay(closed,{customerId:customer.id}),status(409));
      await f.store.put('order',first);
      const shifts=await f.store.list<Shift>('shift','b1');for(const shift of shifts)await f.store.put('shift',{...shift,status:'closed' as const});
      const before=await f.financialState();await assert.rejects(f.pay(first,{customerId:customer.id}),status(409));assert.deepEqual(await f.financialState(),before);
    }finally{await f.finish();}
  });
}
