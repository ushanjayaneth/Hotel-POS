import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server/app';
import type {Snapshot,Order,CreditEntry} from '../shared/types';

const commandId=()=>randomUUID();
async function login(app:Awaited<ReturnType<typeof createApp>>,pin='1234') {const response=await app.inject({method:'POST',url:'/api/login',payload:{pin}});assert.equal(response.statusCode,200,response.body);return {cookie:response.cookies.map(x=>`${x.name}=${x.value}`).join('; ')};}
async function snapshot(app:Awaited<ReturnType<typeof createApp>>,headers:Record<string,string>,branchId='b1'){const response=await app.inject({url:`/api/bootstrap?branchId=${branchId}`,headers});assert.equal(response.statusCode,200,response.body);return response.json<Snapshot>();}

test('catalog writes validate categories and unique scanner codes without resetting omitted product fields',async()=>{
  const app=await createApp({databasePath:':memory:',seed:true});
  try {
    const manager=await login(app,'6666');const cashier=await login(app,'2222');
    const create=await app.inject({method:'POST',url:'/api/categories',headers:manager,payload:{commandId:commandId(),name:'Retail goods',icon:'package'}});assert.equal(create.statusCode,200,create.body);const category=create.json().category;
    assert.equal((await app.inject({method:'POST',url:'/api/categories',headers:manager,payload:{commandId:commandId(),name:'retail goods'}})).statusCode,409);
    assert.equal((await app.inject({method:'POST',url:'/api/categories',headers:cashier,payload:{commandId:commandId(),name:'Forbidden'}})).statusCode,403);
    const old=(await snapshot(app,manager)).menu.find(x=>x.id==='m1')!;
    const update=await app.inject({method:'PATCH',url:'/api/menu/m1',headers:manager,payload:{commandId:commandId(),barcode:'0123456789012',sku:'meal-01'}});assert.equal(update.statusCode,200,update.body);assert.equal(update.json().item.barcode,'0123456789012');assert.equal(update.json().item.sku,'MEAL-01');assert.equal(update.json().item.cost,old.cost);assert.equal(update.json().item.description,old.description);
    const duplicate=await app.inject({method:'PATCH',url:'/api/menu/m2',headers:manager,payload:{commandId:commandId(),barcode:'0123456789012'}});assert.equal(duplicate.statusCode,409);assert.equal(duplicate.json().code,'DUPLICATE_BARCODE');
    assert.equal((await app.inject({method:'PATCH',url:'/api/menu/m2',headers:manager,payload:{commandId:commandId(),sku:'meal-01'}})).statusCode,409);
    assert.equal((await app.inject({method:'PATCH',url:`/api/categories/${category.id}`,headers:manager,payload:{commandId:commandId(),name:'Retail pantry',icon:'package'}})).statusCode,200);
    assert.equal((await app.inject({method:'DELETE',url:`/api/categories/${category.id}`,headers:manager,payload:{commandId:commandId()}})).statusCode,200);
    assert.equal((await app.inject({method:'DELETE',url:'/api/categories/rice',headers:manager,payload:{commandId:commandId()}})).statusCode,409);
  }finally{await app.close();}
});

test('held bills survive a restart, reserve no stock or table, and can be ordered exactly once',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'hotel-held-'));const path=join(directory,'hub.sqlite');let app=await createApp({databasePath:path,seed:true});
  try {
    let headers=await login(app);const before=await snapshot(app,headers);const table=before.tables.find(x=>x.status==='available')!;
    const draft={commandId:commandId(),branchId:'b1',label:'Guest waiting for friends',type:'dine-in',tableId:table.id,lines:[{menuItemId:'m1',quantity:2}]};
    const held=await app.inject({method:'POST',url:'/api/held-bills',headers,payload:draft});assert.equal(held.statusCode,200,held.body);const heldBillId=held.json().heldBill.id;const expectedHeldUpdatedAt=held.json().heldBill.updatedAt;
    assert.deepEqual((await app.inject({method:'POST',url:'/api/held-bills',headers,payload:draft})).json(),held.json());
    const saved=await snapshot(app,headers);assert.equal(saved.heldBills.length,1);assert.equal(saved.orders.length,before.orders.length);assert.equal(saved.tables.find(x=>x.id===table.id)!.status,'available');assert.equal(saved.inventory.find(x=>x.menuItemId==='m1')!.quantity,before.inventory.find(x=>x.menuItemId==='m1')!.quantity);
    await app.close();app=await createApp({databasePath:path,seed:true});headers=await login(app);assert.equal((await snapshot(app,headers)).heldBills[0].id,heldBillId);
    const insufficient={...draft,commandId:commandId(),heldBillId,expectedHeldUpdatedAt,lines:[{menuItemId:'m1',quantity:1000}]};assert.equal((await app.inject({method:'POST',url:'/api/orders',headers,payload:insufficient})).statusCode,409);assert.equal((await snapshot(app,headers)).heldBills.length,1);
    const resume={...draft,commandId:commandId(),heldBillId,expectedHeldUpdatedAt};const order=await app.inject({method:'POST',url:'/api/orders',headers,payload:resume});assert.equal(order.statusCode,200,order.body);assert.equal((await app.inject({method:'POST',url:'/api/orders',headers,payload:resume})).statusCode,200);
    const second=await app.inject({method:'POST',url:'/api/orders',headers,payload:{...resume,commandId:commandId()}});assert.equal(second.statusCode,409);assert.equal(second.json().code,'HELD_BILL_CLOSED');
    const after=await snapshot(app,headers);assert.equal(after.heldBills.length,0);assert.equal(after.orders.length,before.orders.length+1);assert.equal(after.inventory.find(x=>x.menuItemId==='m1')!.quantity,before.inventory.find(x=>x.menuItemId==='m1')!.quantity-2);
  }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});

test('held bill edits preserve one draft, reject stale devices, and synchronize atomically without reserving stock',async()=>{
  const app=await createApp({databasePath:':memory:',seed:true});
  try {
    const headers=await login(app);const before=await snapshot(app,headers);
    const draft={commandId:commandId(),branchId:'b1',label:'Lunch group',type:'takeaway',lines:[{menuItemId:'m1',quantity:1}]};
    const created=await app.inject({method:'POST',url:'/api/held-bills',headers,payload:draft});assert.equal(created.statusCode,200,created.body);
    const initial=created.json().heldBill;
    const update={...draft,commandId:commandId(),label:'Lunch group updated',expectedUpdatedAt:initial.updatedAt,lines:[{menuItemId:'m1',quantity:3}]};
    const saved=await app.inject({method:'PUT',url:`/api/held-bills/${initial.id}`,headers,payload:update});assert.equal(saved.statusCode,200,saved.body);
    const held=saved.json().heldBill;assert.equal(held.id,initial.id);assert.equal(held.createdAt,initial.createdAt);assert.ok(held.updatedAt>initial.updatedAt);assert.equal(held.lines[0].quantity,3);
    assert.deepEqual((await app.inject({method:'PUT',url:`/api/held-bills/${initial.id}`,headers,payload:update})).json(),saved.json());
    const snapshotAfterEdit=await snapshot(app,headers);assert.equal(snapshotAfterEdit.heldBills.length,1);assert.deepEqual(snapshotAfterEdit.inventory,before.inventory);assert.equal(snapshotAfterEdit.orders.length,before.orders.length);
    const event=app.store.db.prepare("SELECT payload FROM outbox WHERE json_extract(payload,'$.action')=?").get(`bill.update:${initial.id}`) as {payload:string};
    const changes=JSON.parse(event.payload).changes;assert.equal(changes.filter((x:{kind:string})=>x.kind==='held').length,1);assert.ok(changes.some((x:{kind:string})=>x.kind==='audit'));assert.ok(!changes.some((x:{kind:string})=>['inventory','order','table'].includes(x.kind)));
    const stale=await app.inject({method:'PUT',url:`/api/held-bills/${initial.id}`,headers,payload:{...update,commandId:commandId(),label:'Stale edit'}});assert.equal(stale.statusCode,409);assert.equal(stale.json().code,'HELD_BILL_CONFLICT');
    const staleOrder=await app.inject({method:'POST',url:'/api/orders',headers,payload:{...draft,commandId:commandId(),heldBillId:initial.id,expectedHeldUpdatedAt:initial.updatedAt}});assert.equal(staleOrder.statusCode,409);assert.equal(staleOrder.json().code,'HELD_BILL_CONFLICT');
    assert.equal((await app.inject({method:'POST',url:'/api/orders',headers,payload:{...draft,commandId:commandId(),heldBillId:initial.id}})).statusCode,409);
    const missingVersion=await app.inject({method:'PUT',url:`/api/held-bills/${initial.id}`,headers,payload:{...update,commandId:commandId(),expectedUpdatedAt:undefined}});assert.equal(missingVersion.statusCode,400);
    const wrongBranch=await app.inject({method:'PUT',url:`/api/held-bills/${initial.id}`,headers,payload:{...update,commandId:commandId(),branchId:'b2',expectedUpdatedAt:held.updatedAt}});assert.equal(wrongBranch.statusCode,404);
    const cashier=await login(app,'2222');assert.equal((await app.inject({method:'PUT',url:`/api/held-bills/${initial.id}`,headers:cashier,payload:{...update,commandId:commandId(),branchId:'b2'}})).statusCode,403);
    const kitchen=await login(app,'4444');assert.equal((await app.inject({method:'PUT',url:`/api/held-bills/${initial.id}`,headers:kitchen,payload:update})).statusCode,403);
    const resume={...draft,commandId:commandId(),heldBillId:held.id,expectedHeldUpdatedAt:held.updatedAt,lines:held.lines};
    const ordered=await app.inject({method:'POST',url:'/api/orders',headers,payload:resume});assert.equal(ordered.statusCode,200,ordered.body);assert.equal(ordered.json().order.lines[0].quantity,3);
    const closed=await app.inject({method:'PUT',url:`/api/held-bills/${initial.id}`,headers,payload:{...update,commandId:commandId(),expectedUpdatedAt:held.updatedAt}});assert.equal(closed.statusCode,409);assert.equal(closed.json().code,'HELD_BILL_CLOSED');
    assert.equal((await snapshot(app,headers)).inventory.find(x=>x.menuItemId==='m1')!.quantity,before.inventory.find(x=>x.menuItemId==='m1')!.quantity-3);
    assert.deepEqual((await app.inject({method:'PUT',url:`/api/held-bills/${initial.id}`,headers,payload:update})).json(),saved.json());
    const toDiscard=await app.inject({method:'POST',url:'/api/held-bills',headers,payload:{...draft,commandId:commandId()}});const discarded=toDiscard.json().heldBill;
    assert.equal((await app.inject({method:'DELETE',url:`/api/held-bills/${discarded.id}`,headers,payload:{commandId:commandId()}})).statusCode,200);
    assert.equal((await app.inject({method:'PUT',url:`/api/held-bills/${discarded.id}`,headers,payload:{...update,commandId:commandId(),expectedUpdatedAt:discarded.updatedAt}})).json().code,'HELD_BILL_CLOSED');
  }finally{await app.close();}
});

test('credit collections reconcile branch dues and the cash drawer once, without booking sales again',async()=>{
  const app=await createApp({databasePath:':memory:',seed:true});
  try {
    const headers=await login(app);const before=await snapshot(app,headers);const open=before.shifts.find(x=>x.status==='open')!;
    const create=await app.inject({method:'POST',url:'/api/orders',headers,payload:{commandId:commandId(),branchId:'b1',type:'takeaway',customerId:'c1',lines:[{menuItemId:'m1',quantity:1}]}});assert.equal(create.statusCode,200,create.body);let order=create.json().order as Order;
    const paid=await app.inject({method:'POST',url:`/api/orders/${order.id}/payments`,headers,payload:{commandId:commandId(),expectedVersion:order.version,method:'credit',amount:order.total}});assert.equal(paid.statusCode,200,paid.body);order=paid.json().order;
    const credited=await snapshot(app,headers);assert.equal(credited.customers.find(x=>x.id==='c1')!.balance,65000);assert.equal(credited.shifts.find(x=>x.id===open.id)!.expectedCash,open.expectedCash);assert.equal(credited.creditEntries.filter(x=>x.type==='sale').length,1);
    const collection={commandId:commandId(),branchId:'b1',amount:25000,method:'cash',reference:'Cash collection'};const first=await app.inject({method:'POST',url:'/api/customers/c1/collections',headers,payload:collection});assert.equal(first.statusCode,200,first.body);assert.equal(first.json().balance,40000);assert.deepEqual((await app.inject({method:'POST',url:'/api/customers/c1/collections',headers,payload:collection})).json(),first.json());
    const after=await snapshot(app,headers);assert.equal(after.shifts.find(x=>x.id===open.id)!.expectedCash,open.expectedCash+25000);assert.equal(after.customers.find(x=>x.id==='c1')!.spent,credited.customers.find(x=>x.id==='c1')!.spent);assert.equal(after.creditEntries.filter(x=>x.type==='collection').length,1);
    assert.equal((await app.inject({method:'POST',url:'/api/customers/c1/collections',headers,payload:{...collection,commandId:commandId(),amount:40001}})).statusCode,409);
    assert.equal((await app.inject({method:'POST',url:'/api/customers/c1/collections',headers,payload:{...collection,commandId:commandId(),branchId:'b2'}})).statusCode,409);
    const waiter=await login(app,'3333');assert.equal((await app.inject({method:'POST',url:'/api/customers/c1/collections',headers:waiter,payload:{...collection,commandId:commandId()}})).statusCode,403);
    const cashier=await login(app,'2222');assert.equal((await app.inject({method:'POST',url:'/api/customers/c1/collections',headers:cashier,payload:{...collection,commandId:commandId(),branchId:'b2'}})).statusCode,403);
  }finally{await app.close();}
});

test('income/expense exports use Colombo dates, collect credit only on receipt, and escape spreadsheet formulas',async()=>{
  const app=await createApp({databasePath:':memory:',seed:true});
  try {
    const headers=await login(app);const example=(await snapshot(app,headers)).orders[0];
    app.store.put<Order>('order',{...example,id:'report-order',number:'REPORT-1',customerId:'c1',payments:[{id:'report-payment-card',orderId:'report-order',method:'card',amount:10000,received:10000,change:0,reference:'',createdAt:'2026-01-02T18:29:59.000Z'},{id:'report-payment-later',orderId:'report-order',method:'cash',amount:8000,received:8000,change:0,reference:'',createdAt:'2026-01-02T18:30:00.000Z'},{id:'report-credit',orderId:'report-order',method:'credit',amount:7000,received:7000,change:0,reference:'',createdAt:'2026-01-02T12:00:00.000Z'}]});
    app.store.put<CreditEntry>('credit',{id:'report-collection',branchId:'b1',customerId:'c1',orderId:null,type:'collection',amount:3000,method:'cash',reference:'=HYPERLINK("https://invalid.example")',note:'=1+1',createdAt:'2026-01-02T12:00:00.000Z',createdBy:'staff-owner'});
    app.store.put('expense',{id:'report-expense',branchId:'b1',category:'Supplies',description:'Cleaning supplies',amount:2000,paymentMethod:'cash',createdAt:'2026-01-02T12:00:00.000Z',createdBy:'staff-owner'});
    app.store.put('refund',{id:'report-refund',branchId:'b1',orderId:'report-order',amount:1000,method:'card',reason:'Returned meal',createdAt:'2026-01-02T12:00:00.000Z'});
    const url='/api/reports/income-expenses?branchId=b1&from=2026-01-02&to=2026-01-02';const report=await app.inject({url:`${url}&format=json`,headers});assert.equal(report.statusCode,200,report.body);assert.equal(report.json().income,13000);assert.equal(report.json().expense,3000);assert.equal(report.json().net,10000);assert.equal(report.json().rows.length,4);
    const csv=await app.inject({url,headers});assert.match(csv.headers['content-type']!,/text\/csv/);assert.ok(csv.body.includes("'=1+1"));assert.ok(csv.body.includes("'=HYPERLINK"));assert.ok(csv.body.includes('"130.00","30.00","100.00"'));
    assert.equal((await app.inject({url:'/api/reports/income-expenses?from=2026-02-01&to=2026-01-01',headers})).statusCode,400);
    const waiter=await login(app,'3333');assert.equal((await app.inject({url,headers:waiter})).statusCode,403);
    const cashier=await login(app,'2222');assert.equal((await app.inject({url:url.replace('branchId=b1','branchId=b2'),headers:cashier})).statusCode,403);
  }finally{await app.close();}
});

test('receipt calibration validates printable bounds and renders configured paper, centered content, and point size',async()=>{
  const app=await createApp({databasePath:':memory:',seed:true});
  try {
    const headers=await login(app);const original=(await snapshot(app,headers)).settings;assert.equal(original.receiptPaperWidthMm,80);assert.equal(original.receiptFontSize,10);
    const tooWide=await app.inject({method:'PUT',url:'/api/settings',headers,payload:{commandId:commandId(),receiptPaperWidthMm:58,receiptContentWidthMm:57,receiptMarginMm:2}});assert.equal(tooWide.statusCode,400);
    const offset=await app.inject({method:'PUT',url:'/api/settings',headers,payload:{commandId:commandId(),receiptPaperWidthMm:58,receiptContentWidthMm:50,receiptMarginMm:2,receiptOffsetMm:3}});assert.equal(offset.statusCode,400);
    const valid=await app.inject({method:'PUT',url:'/api/settings',headers,payload:{commandId:commandId(),receiptPaperWidthMm:58,receiptContentWidthMm:50,receiptMarginMm:2,receiptOffsetMm:1,receiptFontSize:9}});assert.equal(valid.statusCode,200,valid.body);
    const order=(await snapshot(app,headers)).orders[0];const receipt=await app.inject({url:`/api/orders/${order.id}/receipt`,headers});assert.equal(receipt.statusCode,200);assert.ok(receipt.body.includes('size:58mm auto'));assert.ok(receipt.body.includes('width:50mm;margin:0 auto'));assert.ok(receipt.body.includes('left:1mm'));assert.ok(receipt.body.includes('font:9pt'));
    const cashier=await login(app,'2222');assert.equal((await app.inject({method:'PUT',url:'/api/settings',headers:cashier,payload:{receiptFontSize:12}})).statusCode,403);
  }finally{await app.close();}
});

test('retail resale stock decrements on sale and stock edits update reorder/cost atomically with conflict guards',async()=>{
  const app=await createApp({databasePath:':memory:',seed:true});
  try {
    const headers=await login(app);const product=await app.inject({method:'POST',url:'/api/menu',headers,payload:{commandId:commandId(),name:'Bottled water',categoryId:'beverages',price:15000,cost:7000,image:'/images/lime.jpg',stockMode:'prepared',barcode:'4790000000001'}});assert.equal(product.statusCode,200,product.body);const item=product.json().item;
    const create=await app.inject({method:'POST',url:'/api/inventory',headers,payload:{commandId:commandId(),branchId:'b1',name:'Bottled water sale stock',category:'resale',unit:'bottles',quantity:5,minimum:2,unitCost:7000,menuItemId:item.id}});assert.equal(create.statusCode,200,create.body);const inventory=create.json().item;
    const sale=await app.inject({method:'POST',url:'/api/orders',headers,payload:{commandId:commandId(),branchId:'b1',type:'takeaway',lines:[{menuItemId:item.id,quantity:2}]}});assert.equal(sale.statusCode,200,sale.body);assert.equal((await snapshot(app,headers)).inventory.find(x=>x.id===inventory.id)!.quantity,3);
    const stale=await app.inject({method:'PATCH',url:`/api/inventory/${inventory.id}`,headers,payload:{commandId:commandId(),branchId:'b1',quantity:7,minimum:4,unitCost:8000,expectedQuantity:5}});assert.equal(stale.statusCode,409);
    const payload={commandId:commandId(),branchId:'b1',quantity:7,minimum:4,unitCost:8000,expectedQuantity:3,reason:'Physical count and supplier cost'};
    const updated=await app.inject({method:'PATCH',url:`/api/inventory/${inventory.id}`,headers,payload});assert.equal(updated.statusCode,200,updated.body);assert.equal(updated.json().item.quantity,7);assert.equal(updated.json().item.minimum,4);assert.equal(updated.json().item.unitCost,8000);assert.deepEqual((await app.inject({method:'PATCH',url:`/api/inventory/${inventory.id}`,headers,payload})).json(),updated.json());
  }finally{await app.close();}
});
