import 'fake-indexeddb/auto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {HeldBill, InventoryItem, MenuItem, Order, Snapshot} from '../shared/types';
import {businessDate, profitability} from '../shared/costing';
import {createApp} from '../server/app';
import {renderReceipt} from '../server/receipt';
import {Store} from '../server/database';
import {LocalDatabase, LocalStore} from '../src/lib/local/db';
import {createLocalApi, initializeLocalWorkspace} from '../src/lib/local/core';
import {forgetLocalSession} from '../src/lib/local/auth';
import {buildBackupPayload, validateDeviceBackupPayload} from '../src/lib/local/backup';

const commandId=()=>randomUUID();
type Mode='hub'|'device';
async function fixture(mode:Mode){
  const app=mode==='hub'?await createApp({databasePath:':memory:',seed:true}):undefined;
  const db=mode==='device'?new LocalDatabase(`discounts-${commandId()}`):undefined;
  if(db)await initializeLocalWorkspace({businessName:'Discount restaurant',ownerName:'Owner User',pin:'987654',demo:true},db);
  const store=app?(app as unknown as {store:Store}).store:new LocalStore(db!);
  const local=db?createLocalApi(db):undefined;
  let headers:Record<string,string>={};
  const login=async(pin:string)=>{
    if(local){await local('/logout',{});await local('/login',{pin});}
    else {const result=await app!.inject({method:'POST',url:'/api/login',payload:{pin}});assert.equal(result.statusCode,200,result.body);headers={cookie:result.cookies[0].name+'='+result.cookies[0].value};}
  };
  if(app)await login('1234');
  const api=async<T=any>(path:string,body?:unknown,method?:string):Promise<T>=>{
    if(local)return local<T>(path,body,method);
    const response=await app!.inject({url:'/api'+path,method:(method??(body===undefined?'GET':'POST')) as 'GET'|'POST'|'PUT'|'PATCH'|'DELETE',headers,...(body===undefined?{}:{payload:body as any})});
    if(response.statusCode>=400)throw Object.assign(new Error(response.body),{status:response.statusCode});
    return response.json<T>();
  };
  const before=await api<Snapshot>('/bootstrap');
  for(const [id,price,cost,quantity] of [['m1',10000,3000,6],['m2',5000,1000,8]] as const){
    const item=await store.get<MenuItem>('menu',id);await store.put('menu',{...item!,price,reorderLevel:5});
    const stock=(await store.list<InventoryItem>('inventory','b1')).find(row=>row.menuItemId===id)!;
    await store.put('inventory',{...stock,unitCost:cost,quantity});
  }
  const cfg={...before.settings,taxRate:5,serviceChargeRate:10};
  if(app)(store as Store).setMeta('settings',JSON.stringify(cfg));else await(store as LocalStore).setMeta('settings',cfg);
  const stockId=(await store.list<InventoryItem>('inventory','b1')).find(row=>row.menuItemId==='m1')!.id;
  const bill=()=>({commandId:commandId(),branchId:'b1',type:'takeaway',discount:1500,lines:[{menuItemId:'m1',quantity:2,discount:2000},{menuItemId:'m2',quantity:1,discount:500}]});
  const finish=async()=>{if(app)await app.close();if(db){forgetLocalSession(db);await db.delete();}};
  return{app,db,store,api,login,stockId,bill,finish};
}
const status=(expected:number)=>(error:unknown)=>Boolean(error&&typeof error==='object'&&'status'in error&&error.status===expected);

for(const mode of ['hub','device'] as const){
  test(`${mode}: full fixed discounts create a paid kitchen order without inventing a cash payment`,async()=>{
    const f=await fixture(mode);
    try{
      const before=await f.api<Snapshot>('/bootstrap');
      const order=(await f.api<{order:Order}>('/orders',{commandId:commandId(),branchId:'b1',type:'takeaway',discount:5000,lines:[{menuItemId:'m1',quantity:1,discount:5000}]})).order;
      assert.equal(order.subtotal,10000);assert.equal(order.discount,10000);assert.equal(order.cartDiscount,5000);assert.equal(order.total,0);
      assert.equal(order.paymentStatus,'paid');assert.equal(order.status,'new');assert.deepEqual(order.payments,[]);
      const after=await f.api<Snapshot>('/bootstrap');assert.deepEqual(after.shifts,before.shifts);assert.equal((await f.store.get<InventoryItem>('inventory',f.stockId))!.quantity,5);
      const report=profitability({...after,orders:[order],expenses:[]},businessDate(order.createdAt));assert.equal(report.netSales,0);assert.equal(report.costOfSales,3000);assert.equal(report.grossProfit,-3000);
    }finally{await f.finish();}
  });

  test(`${mode}: fixed line and cart discounts charge tax once, preserve costs, and retries deduct stock once`,async()=>{
    const f=await fixture(mode);
    try{
      const start=await f.api<Snapshot>('/bootstrap');
      const table=start.tables.find(row=>row.status==='available')!;
      const payload={...f.bill(),type:'dine-in',tableId:table.id};
      const result=await f.api<{order:Order}>('/orders',payload),order=result.order;
      assert.equal(order.subtotal,25000);assert.equal(order.discount,4000);assert.equal(order.cartDiscount,1500);
      assert.deepEqual(order.lines.map(line=>[line.unitPrice,line.quantity,line.discount,line.lineTotal]),[[10000,2,2000,18000],[5000,1,500,4500]]);
      assert.equal(order.serviceCharge,2100);assert.equal(order.tax,1155);assert.equal(order.total,24255);
      const receipt=renderReceipt(order,start.branch,start.settings);
      assert.match(receipt,/Item discounts<\/td>/);assert.match(receipt,/Cart discount<\/td>/);assert.match(receipt,/25\.00/);assert.match(receipt,/15\.00/);assert.match(receipt,/242\.55/);
      assert.deepEqual(await f.api('/orders',payload),result);
      assert.equal((await f.store.get<InventoryItem>('inventory',f.stockId))!.quantity,4);
      const snapshot=await f.api<Snapshot>('/bootstrap');
      const report=profitability({...snapshot,orders:[order],expenses:[]},businessDate(order.createdAt));
      assert.equal(report.netSales,21000);assert.equal(report.costOfSales,7000);assert.equal(report.grossProfit,14000);
      assert.equal(report.products.find(row=>row.id==='m1')!.netSales,16800);assert.equal(report.products.find(row=>row.id==='m2')!.netSales,4200);
      if(f.db){
        const backup=await buildBackupPayload(f.db);assert.deepEqual(validateDeviceBackupPayload(backup),backup);
        const saved=backup.tables.records.find(row=>row.kind==='order'&&row.id===order.id)!;
        assert.equal(saved.value.cartDiscount,1500);assert.equal((saved.value.lines as Order['lines'])[0].discount,2000);
      }
    }finally{await f.finish();}
  });

  test(`${mode}: invalid and unauthorized discounts cannot alter stock or trust supplied prices`,async()=>{
    const f=await fixture(mode);
    try{
      const initialCount=(await f.store.list('order')).length;
      const invalid=[
        {...f.bill(),lines:[{menuItemId:'m1',quantity:1,discount:10001}]},
        {...f.bill(),lines:[{menuItemId:'m1',quantity:1,discount:-1}]},
        {...f.bill(),lines:[{menuItemId:'m1',quantity:1,discount:0.5}]},
        {...f.bill(),lines:[{menuItemId:'m1',quantity:1,discount:Number.MAX_SAFE_INTEGER+1}]},
        {...f.bill(),discount:8001,lines:[{menuItemId:'m1',quantity:1,discount:2000}]},
      ];
      for(const payload of invalid)await assert.rejects(f.api('/orders',payload),status(400));
      assert.equal((await f.store.get<InventoryItem>('inventory',f.stockId))!.quantity,6);
      assert.equal((await f.store.list('order')).length,initialCount);
      if(f.db)await f.api('/staff',{commandId:commandId(),name:'Cashier User',role:'cashier',branchId:'b1',pin:'456789',phone:''});
      await f.login(f.db?'456789':'2222');
      await assert.rejects(f.api('/orders',{...f.bill(),discount:0}),status(403));
      await assert.rejects(f.api('/held-bills',{...f.bill(),discount:0,label:'Forbidden item discount'}),status(403));
      const forged=await f.api<{order:Order}>('/orders',{commandId:commandId(),branchId:'b1',type:'takeaway',lines:[{menuItemId:'m1',quantity:1,unitPrice:1,lineTotal:1,unitCost:1}]});
      assert.equal(forged.order.lines[0].unitPrice,10000);assert.equal(forged.order.subtotal,10000);assert.equal(forged.order.lines[0].unitCost,undefined);
      const snapshot=await f.api<Snapshot>('/bootstrap');assert.deepEqual(snapshot.inventory,[]);assert.deepEqual(snapshot.recipes,[]);
      assert.equal(snapshot.menu.find(row=>row.id==='m1')!.stockQuantity,5);assert.equal(snapshot.menu.find(row=>row.id==='m1')!.lowStock,true);
      assert.equal(snapshot.menu.find(row=>row.id==='m1')!.cost,0);
    }finally{await f.finish();}
  });

  test(`${mode}: held discounts survive edits and confirmation reprices against current catalog`,async()=>{
    const f=await fixture(mode);
    try{
      const held=(await f.api<{heldBill:HeldBill}>('/held-bills',{...f.bill(),label:'Discounted customer bill'})).heldBill;
      assert.equal(held.discount,1500);assert.equal(held.lines[0].discount,2000);
      const edited=(await f.api<{heldBill:HeldBill}>(`/held-bills/${held.id}`,{...f.bill(),label:'Updated discount',discount:1000,expectedUpdatedAt:held.updatedAt},'PUT')).heldBill;
      assert.equal(edited.discount,1000);assert.equal(edited.lines[1].discount,500);
      const item=(await f.store.get<MenuItem>('menu','m1'))!;await f.store.put('menu',{...item,price:500});
      const confirm={...f.bill(),discount:1000,heldBillId:held.id,expectedHeldUpdatedAt:edited.updatedAt};
      await assert.rejects(f.api('/orders',confirm),status(400));
      assert.equal((await f.store.get<HeldBill>('held',held.id))!.status,'held');assert.equal((await f.store.get<InventoryItem>('inventory',f.stockId))!.quantity,6);
      await f.store.put('menu',item);
      const saved=(await f.api<{order:Order}>('/orders',confirm)).order;
      assert.equal(saved.discount,3500);assert.equal(saved.cartDiscount,1000);assert.equal(saved.lines[0].discount,2000);
      assert.equal((await f.store.get<HeldBill>('held',held.id))!.status,'resumed');
      if(f.db)await f.api('/staff',{commandId:commandId(),name:'Kitchen User',role:'kitchen',branchId:'b1',pin:'456789',phone:''});
      await f.login(f.db?'456789':'4444');
      const kitchen=(await f.api<Snapshot>('/bootstrap')).orders.find(row=>row.id===saved.id)!;
      assert.equal(kitchen.discount,0);assert.equal(kitchen.cartDiscount,0);assert.equal(kitchen.total,0);assert.equal(kitchen.lines[0].discount,0);assert.equal(kitchen.lines[0].lineTotal,0);assert.equal(kitchen.lines[0].unitCost,undefined);
    }finally{await f.finish();}
  });
}
