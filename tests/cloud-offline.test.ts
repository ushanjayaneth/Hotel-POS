import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createMonitorHandler} from '../server/monitor/handler';
import {monitorCommand} from '../server/monitor/engine';
import {MemoryMonitorStore,recordKey,type Projection} from '../server/monitor/store';
import type {CloudChange} from '../shared/cloud-monitor';
import type {OfflineCloudCommit,OfflineCloudResult} from '../shared/offline-cloud';
import type {Order} from '../shared/types';

const env={CLOUD_POS_PIN:'98765432',CLOUD_SESSION_SECRET:'s'.repeat(64)};
function baseline():Projection {
  const timestamp=new Date().toISOString();
  const settings={businessName:'Offline Test',tagline:'',currency:'LKR',taxRate:0,serviceChargeRate:0,receiptFooter:'',lowStockAlerts:true,autoPrint:false,language:'en',receiptPaperWidthMm:80,receiptContentWidthMm:72,receiptMarginMm:2,receiptOffsetMm:0,receiptFontSize:10};
  const rows:CloudChange[]=[
    {kind:'branch',id:'b1',branchId:null,value:{id:'b1',name:'Test',nameSi:'Test',code:'TEST',address:'',phone:''}},
    {kind:'settings',id:'settings',branchId:null,value:settings},
    {kind:'category',id:'food',branchId:null,value:{id:'food',name:'Food',nameSi:'Food',icon:'grid'}},
    {kind:'menu',id:'rice',branchId:null,value:{id:'rice',name:'Rice',nameSi:'Rice',description:'',categoryId:'food',price:10000,cost:4000,image:'/images/curry.jpg',available:true,stockMode:'prepared',preparationMinutes:1}},
    {kind:'inventory',id:'stock-rice',branchId:'b1',value:{id:'stock-rice',branchId:'b1',name:'Rice',nameSi:'Rice',category:'prepared',unit:'portions',quantity:3,minimum:1,unitCost:4000,supplierId:null,menuItemId:'rice',updatedAt:timestamp}},
    {kind:'customer',id:'guest',branchId:null,value:{id:'guest',name:'Guest',phone:'0771234567',email:'',visits:0,spent:0,balance:0,points:0,createdAt:timestamp}},
    {kind:'shift',id:'shift',branchId:'b1',value:{id:'shift',branchId:'b1',openedBy:'cloud-owner',openedAt:timestamp,openingFloat:100000,status:'open',closedAt:null,countedCash:null,expectedCash:100000,variance:null}},
  ];
  return {revision:1,source:{sourceId:'shop',workspaceId:'business',businessName:'Offline Test',deviceName:'Shared',epoch:'epoch',sequence:0,ready:true,shared:true,revoked:false,updatedAt:timestamp,lastSeenAt:timestamp,dataVersion:1},records:Object.fromEntries(rows.map(row=>[recordKey(row.kind,row.id),row])),metadata:{settings,activeBranchId:'b1',deviceId:'cloud'},commands:{}};
}
async function fixture(initial=baseline()){
  const store=new MemoryMonitorStore();await store.replace('shop',null,initial);
  const handler=createMonitorHandler({store,env});let cookie='';
  const call=async(action:string,body?:unknown,authenticated=true)=>handler(new Request(`https://shop.test/api/cloud?action=${action}`,{
    method:body===undefined?'GET':'POST',headers:{Origin:'https://shop.test','Content-Type':'application/json',...(authenticated?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body),
  }));
  const login=await call('pos-login',{pin:env.CLOUD_POS_PIN});cookie=login.headers.get('set-cookie')!.split(';')[0];
  return {store,call,current:async()=>(await store.get('shop'))!};
}
function device(snapshot:Projection,deviceId:string){
  const local=structuredClone(snapshot);local.metadata.deviceId=deviceId;
  return {local,async command<T=Record<string,unknown>>(path:string,body:Record<string,unknown>,method='POST',offline=true){
    const before=structuredClone(local),transactionId=String(body.commandId??randomUUID());
    const result=await monitorCommand(local,path,method,{...body,commandId:transactionId},new URLSearchParams()) as T;
    const changes=[...new Set([...Object.keys(local.records),...Object.keys(before.records)])].filter(key=>JSON.stringify(local.records[key])!==JSON.stringify(before.records[key])).map(key=>{
      const row=local.records[key]??before.records[key];return {kind:row.kind,id:row.id,branchId:row.branchId,before:before.records[key]?.value??null,after:local.records[key]?.value??null};
    });
    const packet:OfflineCloudCommit={sourceId:'shop',deviceId,transactionId,createdAt:new Date().toISOString(),path,method,offline,changes};
    return {result,packet};
  }};
}
const sale=(d:ReturnType<typeof device>,offline=true)=>d.command<{order:Order}>('/orders',{branchId:'b1',type:'takeaway',lines:[{menuItemId:'rice',quantity:1}]},'POST',offline);
const values=(projection:Projection,kind:string)=>Object.values(projection.records).filter(row=>row.kind===kind).map(row=>row.value);

test('shared offline bootstrap requires PIN and exports business records without server deduplication or credentials',async()=>{
  const f=await fixture();
  assert.equal((await f.call('bootstrap&sourceId=shop&includeOffline=1',undefined,false)).status,401);
  const projection=await f.current();projection.commands.secret={hash:'secret-hash',response:{private:'not-exported'}};projection.metadata.secret='not-exported';await f.store.replace('shop',projection.revision,{...projection,revision:projection.revision+1});
  const response=await f.call('bootstrap&sourceId=shop&branchId=b1&includeOffline=1');
  assert.equal(response.status,200);const data=await response.json();
  assert.equal(data.offlineState.records.length,Object.keys(projection.records).length);
  assert.equal(data.offlineState.metadata.settings.businessName,'Offline Test');
  assert.deepEqual(Object.keys(data.offlineState.metadata).sort(),['activeBranchId','deviceId','settings']);
  assert.doesNotMatch(JSON.stringify(data),/secret-hash|not-exported|98765432/);
});

test('four disconnected registers keep all physically completed sales, stock deltas and captured prices',async()=>{
  const f=await fixture(),cached=await f.current();
  const packets=await Promise.all(Array.from({length:4},async(_,index)=>(await sale(device(cached,`offline-device-${index}`))).packet));
  const changed=await f.current();changed.records[recordKey('menu','rice')].value.price=20000;changed.revision++;await f.store.replace('shop',changed.revision-1,changed);
  const responses=await Promise.all(packets.map(packet=>f.call('offline-commit',packet)));
  assert.deepEqual(responses.map(value=>value.status),[200,200,200,200]);
  const results=await Promise.all(responses.map(value=>value.json() as Promise<OfflineCloudResult>));
  assert.equal(results.filter(value=>value.warnings.length>0).length,1);
  const current=await f.current();assert.equal(current.records[recordKey('inventory','stock-rice')].value.quantity,-1);
  assert.equal(values(current,'order').length,4);assert.equal(values(current,'movement').length,4);
  assert.ok(values(current,'order').every(order=>order.total===10000));
  assert.ok(values(current,'audit').some(event=>event.action==='offline.reconciliation-review'));
});

test('online local-first registers still use CAS stock checks and never confirm a fourth last-item sale',async()=>{
  const f=await fixture(),cached=await f.current();
  const packets=await Promise.all(Array.from({length:4},async(_,index)=>(await sale(device(cached,`online-device-${index}`),false)).packet));
  const responses=await Promise.all(packets.map(packet=>f.call('offline-commit',packet)));
  assert.deepEqual(responses.map(value=>value.status).sort(),[200,200,200,409]);
  const rejected=responses.find(value=>value.status===409)!;assert.equal((await rejected.json()).code,'INSUFFICIENT_STOCK');
  const current=await f.current();assert.equal(values(current,'order').length,3);assert.equal(current.records[recordKey('inventory','stock-rice')].value.quantity,0);
});

test('lost acknowledgements replay the exact transaction once, including false to offline flag upgrades',async()=>{
  const f=await fixture(),d=device(await f.current(),'ack-device'),created=await sale(d,false);
  assert.equal((await f.call('offline-commit',created.packet)).status,200);
  const replay=await f.call('offline-commit',{...created.packet,offline:true});assert.equal(replay.status,200);
  const payment=await d.command<{order:Order}>(`/orders/${created.result.order.id}/payments`,{expectedVersion:1,method:'cash',amount:10000,received:12000},'POST',false);
  const first=await f.call('offline-commit',payment.packet);assert.equal(first.status,200);const acknowledged=await first.json();
  assert.deepEqual(await (await f.call('offline-commit',{...payment.packet,offline:true})).json(),acknowledged);
  const current=await f.current();assert.equal(values(current,'order').length,1);assert.equal(values(current,'order')[0].paid,10000);
  assert.equal((values(current,'order')[0].payments as unknown[]).length,1);assert.equal(current.records[recordKey('shift','shift')].value.expectedCash,110000);
  const changed=structuredClone(payment.packet);changed.changes[0].after!.note='Different packet';
  assert.equal((await f.call('offline-commit',changed)).status,409);
});

test('offline loans and partial collections preserve other devices balances and remain idempotent',async()=>{
  const f=await fixture(),d=device(await f.current(),'loan-device'),order=await sale(d);
  const payment=await d.command(`/orders/${order.result.order.id}/payments`,{expectedVersion:1,method:'credit',customerId:'guest',amount:10000,received:10000});
  for(const packet of [order.packet,payment.packet])assert.equal((await f.call('offline-commit',packet)).status,200);
  const remote=device(await f.current(),'collection-device'),collection=await remote.command('/customers/guest/collections',{branchId:'b1',amount:4000,method:'cash',reference:'',note:''});
  assert.equal((await f.call('offline-commit',collection.packet)).status,200);
  const collection2=await d.command('/customers/guest/collections',{branchId:'b1',amount:2000,method:'cash',reference:'',note:''});
  assert.equal((await f.call('offline-commit',collection2.packet)).status,200);
  assert.equal((await f.call('offline-commit',collection2.packet)).status,200);
  const current=await f.current(),guest=current.records[recordKey('customer','guest')].value;
  assert.equal(guest.balance,4000);assert.equal(guest.spent,10000);assert.equal(guest.visits,1);assert.equal(values(current,'credit').length,3);
  assert.equal(current.records[recordKey('shift','shift')].value.expectedCash,106000);
});

test('concurrent offline payments retain every receipt and online stale payments reject before commit',async()=>{
  const f=await fixture(),created=await sale(device(await f.current(),'original'));
  await f.call('offline-commit',created.packet);const cached=await f.current();
  const devices=[device(cached,'pay-a'),device(cached,'pay-b')];
  const payments=await Promise.all(devices.map(d=>d.command(`/orders/${created.result.order.id}/payments`,{expectedVersion:1,method:'cash',amount:10000,received:10000})));
  assert.equal((await f.call('offline-commit',payments[0].packet)).status,200);
  const online=await f.call('offline-commit',{...payments[1].packet,offline:false});assert.equal(online.status,409);assert.equal((await online.json()).code,'VERSION_CONFLICT');
  const physical=await f.call('offline-commit',payments[1].packet);assert.equal(physical.status,200);assert.match((await physical.json()).warnings.join(' '),/overpayment/);
  const current=await f.current(),order=current.records[recordKey('order',created.result.order.id)].value;
  assert.equal(order.paid,20000);assert.equal((order.payments as unknown[]).length,2);assert.equal(current.records[recordKey('shift','shift')].value.expectedCash,120000);
});

test('invalid offline money or stock records leave the cloud transaction unchanged',async()=>{
  const f=await fixture(),d=device(await f.current(),'invalid-device'),created=await sale(d);
  const bad=structuredClone(created.packet);bad.changes.find(row=>row.kind==='order')!.after!.total=999;
  const before=await f.current();assert.equal((await f.call('offline-commit',bad)).status,409);assert.deepEqual(await f.current(),before);
  const missingMovement=structuredClone(created.packet);missingMovement.changes=missingMovement.changes.filter(row=>row.kind!=='movement');
  assert.equal((await f.call('offline-commit',missingMovement)).status,409);assert.deepEqual(await f.current(),before);
  assert.equal((await f.call('offline-commit',created.packet)).status,200);
  const payment=await d.command(`/orders/${created.result.order.id}/payments`,{expectedVersion:1,method:'cash',amount:10000,received:10000});
  payment.packet.changes.find(row=>row.kind==='shift')!.after!.expectedCash=999999;
  const beforePayment=await f.current();assert.equal((await f.call('offline-commit',payment.packet)).status,409);assert.deepEqual(await f.current(),beforePayment);
});

test('offline commits require PIN session, same origin, bounded whitelisted effects and pending order dependencies',async()=>{
  const f=await fixture(),d=device(await f.current(),'auth-device'),order=await sale(d);
  assert.equal((await f.call('offline-commit',order.packet,false)).status,401);
  const payment=await d.command(`/orders/${order.result.order.id}/payments`,{expectedVersion:1,method:'cash',amount:10000,received:10000});
  assert.equal((await f.call('offline-commit',payment.packet)).status,409);
  assert.equal(values(await f.current(),'order').length,0);
  assert.equal((await f.call('offline-commit',{...order.packet,path:'/settings'})).status,409);
  const credential=structuredClone(order.packet);credential.changes[0].after!.password='must-not-upload';
  assert.equal((await f.call('offline-commit',credential)).status,400);
  assert.equal((await f.call('offline-commit',{...order.packet,changes:[...order.packet.changes,...order.packet.changes]})).status,409);
});

test('online overcollections reject atomically while actual offline collections remain visible as a customer advance',async()=>{
  const f=await fixture(),d=device(await f.current(),'loan-counter'),order=await sale(d);
  const loan=await d.command(`/orders/${order.result.order.id}/payments`,{expectedVersion:1,method:'credit',customerId:'guest',amount:10000,received:10000});
  for(const packet of [order.packet,loan.packet])assert.equal((await f.call('offline-commit',packet)).status,200);
  const cached=await f.current(),a=device(cached,'collection-a'),b=device(cached,'collection-b');
  const one=await a.command('/customers/guest/collections',{branchId:'b1',amount:8000,method:'cash',reference:'',note:''},'POST',false);
  const two=await b.command('/customers/guest/collections',{branchId:'b1',amount:8000,method:'cash',reference:'',note:''},'POST',false);
  assert.equal((await f.call('offline-commit',one.packet)).status,200);const before=await f.current();
  const rejected=await f.call('offline-commit',two.packet);assert.equal(rejected.status,409);assert.equal((await rejected.json()).code,'COLLECTION_EXCEEDS_BALANCE');assert.deepEqual(await f.current(),before);
  const offline=await f.call('offline-commit',{...two.packet,offline:true});assert.equal(offline.status,200);assert.match((await offline.json()).warnings.join(' '),/advance balance/);
  assert.equal((await f.current()).records[recordKey('customer','guest')].value.balance,-6000);
});

test('cash expenses cannot spend the same recorded cash twice online and offline physical expenses are preserved',async()=>{
  const f=await fixture(),cached=await f.current(),devices=[device(cached,'cash-a'),device(cached,'cash-b')];
  const expenses=await Promise.all(devices.map(d=>d.command('/expenses',{branchId:'b1',category:'Utilities',description:'Cash utility payment',amount:70000,paymentMethod:'cash'},'POST',false)));
  assert.equal((await f.call('offline-commit',expenses[0].packet)).status,200);const before=await f.current();
  const rejected=await f.call('offline-commit',expenses[1].packet);assert.equal(rejected.status,409);assert.equal((await rejected.json()).code,'INSUFFICIENT_CASH');assert.deepEqual(await f.current(),before);
  assert.equal((await f.call('offline-commit',{...expenses[1].packet,offline:true})).status,200);
  const current=await f.current();assert.equal(values(current,'expense').length,2);assert.equal(current.records[recordKey('shift','shift')].value.expectedCash,-40000);
});

test('offline recipe sales retain fractional ingredient consumption, fixed discounts and rounded tax captures',async()=>{
  const initial=baseline(),settings=initial.metadata.settings as Record<string,unknown>;
  settings.taxRate=18;settings.serviceChargeRate=10;initial.records[recordKey('menu','rice')].value.stockMode='recipe';
  initial.records[recordKey('recipe','rice')]={kind:'recipe',id:'rice',branchId:null,value:{id:'rice',ingredients:[{key:'stock-rice',quantity:0.125}]}};
  const f=await fixture(initial),d=device(await f.current(),'recipe-register');
  const created=await d.command<{order:Order}>('/orders',{branchId:'b1',type:'dine-in',discount:500,lines:[{menuItemId:'rice',quantity:1,discount:200}]});
  assert.equal(created.result.order.tax,1841);assert.equal(created.result.order.serviceCharge,930);assert.equal(created.result.order.total,12071);
  const remote=await f.current();remote.records[recordKey('recipe','rice')].value.ingredients=[{key:'stock-rice',quantity:0.3}];remote.revision++;await f.store.replace('shop',remote.revision-1,remote);
  assert.equal((await f.call('offline-commit',created.packet)).status,200);
  const current=await f.current();assert.equal(current.records[recordKey('inventory','stock-rice')].value.quantity,2.875);assert.equal(values(current,'order')[0].total,12071);
});

test('a full offline product setup stores category, buying cost, selling price, stock adjustments and captured sale profit',async()=>{
  const f=await fixture(),d=device(await f.current(),'product-counter');
  const category=await d.command<{category:{id:string}}>('/categories',{name:'Offline meals',icon:'grid'});
  const product=await d.command<{item:{id:string}}>('/menu',{name:'Fried rice',nameSi:'Fried rice',description:'Offline product',categoryId:category.result.category.id,price:12000,cost:3000,image:'/images/curry.jpg',stockMode:'prepared',barcode:'OFFLINE-100',available:true});
  const stock=await d.command<{item:{id:string}}>('/inventory',{branchId:'b1',name:'Fried rice',category:'prepared',unit:'portions',quantity:10,minimum:5,unitCost:3000,menuItemId:product.result.item.id});
  const price=await d.command(`/menu/${product.result.item.id}`,{price:14000,cost:4000},'PATCH');
  const count=await d.command(`/inventory/${stock.result.item.id}`,{branchId:'b1',quantity:8,expectedQuantity:10,unitCost:5000,minimum:2,reason:'Physical count and supplier cost update'},'PATCH');
  const order=await d.command<{order:Order}>('/orders',{branchId:'b1',type:'takeaway',lines:[{menuItemId:product.result.item.id,quantity:1}]});
  const payment=await d.command(`/orders/${order.result.order.id}/payments`,{expectedVersion:1,method:'cash',amount:14000,received:15000});
  const expense=await d.command('/expenses',{branchId:'b1',category:'Utilities',description:'Daily electricity',amount:3000,paymentMethod:'cash'});
  for(const operation of [category,product,stock,price,count,order,payment,expense]){
    const response=await f.call('offline-commit',operation.packet);assert.equal(response.status,200,JSON.stringify(await response.json()));
  }
  const current=await f.current(),bill=current.records[recordKey('order',order.result.order.id)].value;
  assert.equal(current.records[recordKey('inventory',stock.result.item.id)].value.quantity,7);
  assert.equal(current.records[recordKey('menu',product.result.item.id)].value.price,14000);
  assert.equal((bill.lines as {unitCost:number}[])[0].unitCost,5000);assert.equal(bill.total,14000);assert.equal(bill.paid,14000);
  assert.equal(current.records[recordKey('shift','shift')].value.expectedCash,111000);
});

test('independent product edits merge fields and disconnected stale prices resolve per field with review history',async()=>{
  const f=await fixture(),cached=await f.current(),one=device(cached,'price-counter'),two=device(cached,'description-counter'),three=device(cached,'stale-price-counter');
  const price=await one.command('/menu/rice',{price:12000},'PATCH'),description=await two.command('/menu/rice',{description:'Updated description'},'PATCH'),stale=await three.command('/menu/rice',{price:13000},'PATCH');
  const timestamp=Date.now();price.packet.createdAt=new Date(timestamp+1000).toISOString();stale.packet.createdAt=new Date(timestamp+2000).toISOString();
  assert.equal((await f.call('offline-commit',price.packet)).status,200);assert.equal((await f.call('offline-commit',description.packet)).status,200);
  const before=await f.current(),response=await f.call('offline-commit',{...stale.packet,offline:false});assert.equal(response.status,409);assert.equal((await response.json()).code,'OFFLINE_CATALOG_CONFLICT');assert.deepEqual(await f.current(),before);
  assert.equal(before.records[recordKey('menu','rice')].value.price,12000);assert.equal(before.records[recordKey('menu','rice')].value.description,'Updated description');
  const completed=await f.call('offline-commit',stale.packet);assert.equal(completed.status,200);assert.match((await completed.json()).warnings.join(' '),/later field edit/);
  const reconciled=await f.current();assert.equal(reconciled.records[recordKey('menu','rice')].value.price,13000);assert.equal(reconciled.records[recordKey('menu','rice')].value.description,'Updated description');
  assert.ok(values(reconciled,'audit').some(row=>String(row.detail).includes('"existing":12000')&&String(row.detail).includes('"proposed":13000')));
});

test('offline receipt settings synchronize metadata and records and category deletion preserves referenced products',async()=>{
  const f=await fixture(),d=device(await f.current(),'settings-counter');
  const settings=await d.command('/settings',{businessName:'Offline Cafe',receiptPaperWidthMm:58,receiptContentWidthMm:50,receiptMarginMm:2,receiptOffsetMm:0,receiptFooter:'Visit again'},'PUT');
  assert.equal((await f.call('offline-commit',settings.packet)).status,200);const current=await f.current();
  assert.deepEqual(current.metadata.settings,current.records[recordKey('settings','settings')].value);assert.equal(current.source.businessName,'Offline Cafe');
  const category=await d.command<{category:{id:string}}>('/categories',{name:'Temporary',icon:'grid'});await f.call('offline-commit',category.packet);
  const deletion=await d.command(`/categories/${category.result.category.id}`,{},'DELETE');assert.equal((await f.call('offline-commit',deletion.packet)).status,200);
  assert.equal((await f.current()).records[recordKey('category',category.result.category.id)],undefined);
});

test('offline purchases merge actual incoming quantities, weighted costs and supplier dues against current stock',async()=>{
  const f=await fixture(),setup=device(await f.current(),'supplier-counter'),supplier=await setup.command<{supplier:{id:string}}>('/suppliers',{name:'Rice Supplier',phone:'0771112222',email:''});
  assert.equal((await f.call('offline-commit',supplier.packet)).status,200);
  const cached=await f.current(),a=device(cached,'purchase-a'),b=device(cached,'purchase-b');
  const one=await a.command('/purchases',{branchId:'b1',supplierId:supplier.result.supplier.id,invoiceNumber:'A-1',lines:[{itemId:'stock-rice',quantity:3,unitCost:8000}]});
  const two=await b.command('/purchases',{branchId:'b1',supplierId:supplier.result.supplier.id,invoiceNumber:'B-1',lines:[{itemId:'stock-rice',quantity:4,unitCost:10000}]});
  assert.equal((await f.call('offline-commit',one.packet)).status,200);assert.equal((await f.call('offline-commit',two.packet)).status,200);
  const current=await f.current(),stock=current.records[recordKey('inventory','stock-rice')].value;
  assert.equal(stock.quantity,10);assert.equal(stock.unitCost,7600);assert.equal(current.records[recordKey('supplier',supplier.result.supplier.id)].value.balance,64000);
  assert.equal(values(current,'purchase').length,2);assert.equal((await f.call('offline-commit',two.packet)).status,200);
  assert.equal((await f.current()).records[recordKey('inventory','stock-rice')].value.quantity,10);
});

test('offline production and wastage preserve ingredient deductions, prepared cost and wastage loss',async()=>{
  const initial=baseline(),timestamp=new Date().toISOString();
  initial.records[recordKey('inventory','ingredient')]={kind:'inventory',id:'ingredient',branchId:'b1',value:{id:'ingredient',branchId:'b1',name:'Raw rice',nameSi:'Raw rice',category:'ingredient',unit:'kg',quantity:10,minimum:1,unitCost:20000,supplierId:null,menuItemId:null,updatedAt:timestamp}};
  initial.records[recordKey('recipe','rice')]={kind:'recipe',id:'rice',branchId:null,value:{id:'rice',ingredients:[{key:'ingredient',quantity:0.2}],batchYield:1}};
  const f=await fixture(initial),cached=await f.current(),a=device(cached,'kitchen-a'),b=device(cached,'kitchen-b');
  const produced=await a.command('/production',{branchId:'b1',menuItemId:'rice',quantity:2,note:'Lunch batch'});
  const wasted=await b.command('/inventory/wastage',{branchId:'b1',itemId:'stock-rice',quantity:1,reason:'Spoiled food'});
  const recipe=await b.command('/menu/rice/recipe',{batchYield:1,ingredients:[{key:'ingredient',quantity:0.25}]},'PUT');
  for(const operation of [wasted,produced,recipe]){const response=await f.call('offline-commit',operation.packet);assert.equal(response.status,200,JSON.stringify(await response.json()));}
  const current=await f.current();assert.equal(current.records[recordKey('inventory','ingredient')].value.quantity,9.6);assert.equal(current.records[recordKey('inventory','stock-rice')].value.quantity,4);
  assert.equal(current.records[recordKey('inventory','stock-rice')].value.unitCost,4000);assert.equal(values(current,'production').length,1);
  assert.equal(values(current,'movement').find(value=>value.type==='waste')!.totalCost,4000);assert.deepEqual(current.records[recordKey('recipe','rice')].value.ingredients,[{key:'ingredient',quantity:0.25}]);
});

test('cloud photos require authenticated access, stay immutable and never enlarge normal bill projections',async()=>{
  const f=await fixture(),timestamp=new Date().toISOString();
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=','base64');
  const photo={id:`media-${randomUUID()}`,mime:'image/png',data:png.toString('base64'),byteLength:png.length,width:1,height:1,branchId:null,createdAt:timestamp};
  const packet:OfflineCloudCommit={sourceId:'shop',deviceId:'photo-counter',transactionId:randomUUID(),createdAt:timestamp,path:'/media',method:'POST',offline:true,changes:[{kind:'media',id:photo.id,branchId:null,before:null,after:photo}]};
  assert.equal((await f.call('offline-commit',packet)).status,200);const before=await f.current();
  assert.equal(values(before,'media').length,0);assert.equal((await f.store.getMedia('shop',photo.id))!.data,photo.data);
  assert.equal((await f.call(`media&sourceId=shop&id=${photo.id}`,undefined,false)).status,401);
  assert.equal((await f.call(`media&sourceId=other&id=${photo.id}`)).status,404);
  const response=await f.call(`media&sourceId=shop&id=${photo.id}`);assert.equal(response.status,200);assert.equal((await response.json()).media.data,photo.data);
  const changed=structuredClone(packet);changed.transactionId=randomUUID();const bytes=Buffer.concat([png,Buffer.from([0])]);changed.changes[0].after!.data=bytes.toString('base64');changed.changes[0].after!.byteLength=bytes.length;
  const conflict=await f.call('offline-commit',changed);assert.equal(conflict.status,409);assert.equal((await conflict.json()).code,'PHOTO_CONFLICT');assert.deepEqual(await f.current(),before);
  const large=structuredClone(packet);large.transactionId=randomUUID();large.changes[0].id=`media-${randomUUID()}`;large.changes[0].after!.id=large.changes[0].id;
  const oversized=Buffer.concat([png,Buffer.alloc(450001-png.length)]);large.changes[0].after!.data=oversized.toString('base64');large.changes[0].after!.byteLength=oversized.length;
  assert.equal((await f.call('offline-commit',large)).status,409);assert.equal(await f.store.getMedia('shop',large.changes[0].id),null);
  const bootstrap=await (await f.call('bootstrap&sourceId=shop&includeOffline=1')).json();assert.equal(bootstrap.offlineState.records.some((row:CloudChange)=>row.kind==='media'),false);assert.doesNotMatch(JSON.stringify(bootstrap),new RegExp(photo.data));
});

test('concurrent disconnected price edits converge per field regardless of upload order',async()=>{
  const initial=baseline(),a=device(initial,'price-a'),b=device(initial,'price-b');
  const older=await a.command('/menu/rice',{price:12000},'PATCH'),newer=await b.command('/menu/rice',{price:13000},'PATCH');
  const timestamp=Date.now();older.packet.createdAt=new Date(timestamp+1000).toISOString();newer.packet.createdAt=new Date(timestamp+2000).toISOString();
  for(const order of [[older.packet,newer.packet],[newer.packet,older.packet]]){
    const f=await fixture(structuredClone(initial));
    for(const packet of order)assert.equal((await f.call('offline-commit',packet)).status,200);
    assert.equal((await f.current()).records[recordKey('menu','rice')].value.price,13000);
  }
});
