import {test,expect,type Browser,type Page} from '@playwright/test';
import staticPlugin from '@fastify/static';
import {resolve} from 'node:path';
import {createApp} from '../server/app';
import {MemoryMonitorStore,recordKey,type Projection} from '../server/monitor/store';

test.setTimeout(180_000);
test.use({actionTimeout:15000});
const pin='98765432';

async function navigate(page:Page,name:string){
  const open=page.getByRole('button',{name:'Open navigation',exact:true});
  if(await open.isVisible())await open.click();
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:new RegExp(`^${name}`)}).click();
}

async function deviceRecords(page:Page){
  return page.evaluate(()=>new Promise<unknown[]>((resolve,reject)=>{
    const opening=indexedDB.open('demo-hotel-local-workspace-v1');
    opening.onerror=()=>reject(opening.error);
    opening.onsuccess=()=>{
      const database=opening.result,transaction=database.transaction('records','readonly');
      const request=transaction.objectStore('records').getAll();
      transaction.oncomplete=()=>{database.close();resolve(request.result);};
      transaction.onabort=()=>{database.close();reject(transaction.error);};
    };
  }));
}

// All writes go to a new in-memory cloud and fresh browser contexts. The
// independent device workspace is checked at the end to catch accidental writes.
async function openSharedShop(browser:Browser){
  const store=new MemoryMonitorStore();
  const app=await createApp({databasePath:':memory:',seed:true,monitor:{store,env:{CLOUD_POS_PIN:pin,CLOUD_SESSION_SECRET:'w'.repeat(64)}}});
  await app.register(staticPlugin,{root:resolve('dist'),wildcard:false});
  const origin=await app.listen({host:'127.0.0.1',port:0});
  const counter=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'allow'});
  const other=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
  const page=await counter.newPage(),remote=await other.newPage(),errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  remote.on('pageerror',error=>errors.push(error.message));
  const signIn=async(target:Page)=>{
    await target.goto(origin);
    await target.getByLabel('Staff PIN',{exact:true}).fill(pin);
    await target.getByRole('button',{name:'Open workspace',exact:true}).click();
    await expect(target.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();
  };
  try{
    await page.goto(`${origin}/?local=1`);
    await page.getByRole('button',{name:'Set up this device',exact:true}).click();
    const setup=page.getByRole('dialog',{name:'Set up this device',exact:true});
    await setup.getByLabel('Business name',{exact:true}).fill('Offline Management Hotel');
    await setup.getByLabel('Owner name',{exact:true}).fill('Management Owner');
    await setup.getByLabel(/^Owner PIN/).fill(pin);
    await setup.getByLabel('Confirm owner PIN',{exact:true}).fill(pin);
    await setup.getByRole('checkbox',{name:/^Include sample menu/}).check();
    await setup.getByRole('button',{name:'Create device workspace',exact:true}).click();
    await expect(page.getByRole('button',{name:'Add Chicken rice & curry',exact:true})).toBeVisible();
    const original=await deviceRecords(page);
    await signIn(page);
    const source=(await store.list()).find(source=>source.ready&&source.shared)!;
    expect(source).toBeDefined();
    await expect(page).toHaveURL(new RegExp(`shared=${source.sourceId}`));
    await signIn(remote);
    await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
    await page.reload();
    await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();
    await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);
    return {store,app,counter,other,page,remote,source,original,errors};
  }catch(error){await counter.close();await other.close();await app.close();throw error;}
}

const records=(projection:Projection,kind:string)=>Object.values(projection.records).filter(row=>row.kind===kind);
const inventoryRow=(page:Page,name:string)=>page.getByRole('table').filter({has:page.getByRole('columnheader',{name:'In stock',exact:true})}).getByRole('row').filter({hasText:name});

test('offline suppliers, stock counts, purchases, recipes, production and wastage survive reload and sync exactly once',async({browser})=>{
  const {store,app,counter,other,page,remote,source,original,errors}=await openSharedShop(browser);
  const supplierName='Offline Kitchen Supplier',ingredientName='Offline Batch Rice',ingredientId='b1-offline-batch-rice';
  try{
    const before=(await store.get(source.sourceId))!;
    await counter.setOffline(true);
    await page.reload();
    await expect(page.locator('.notice-banner')).toContainText('Working offline');
    await navigate(page,'Purchases');
    await page.getByRole('button',{name:'Add supplier',exact:true}).click();
    const supplier=page.getByRole('dialog',{name:'Add supplier',exact:true});
    await supplier.getByLabel('Supplier name',{exact:true}).fill(supplierName);
    await supplier.getByLabel('Phone number',{exact:true}).fill('0773344556');
    await supplier.getByLabel('Email (optional)',{exact:true}).fill('offline@example.test');
    await supplier.getByRole('button',{name:'Add supplier',exact:true}).click();
    await expect(supplier).toHaveCount(0);

    await navigate(page,'Inventory');
    await page.getByRole('button',{name:'Add item',exact:true}).click();
    const item=page.getByRole('dialog',{name:'Add inventory item',exact:true});
    await item.getByLabel('Item name',{exact:true}).fill(ingredientName);
    await item.getByRole('combobox',{name:/^Stock category/}).selectOption('ingredient');
    await item.getByRole('combobox',{name:/^Stock unit/}).selectOption('kg');
    await item.getByLabel('Opening quantity',{exact:true}).fill('10');
    await item.getByLabel('Reorder level',{exact:true}).fill('2');
    await item.getByLabel('Cost per stock unit (LKR)',{exact:true}).fill('100');
    await item.getByRole('combobox',{name:/^Supplier \(optional\)/}).selectOption({label:supplierName});
    await item.getByRole('button',{name:'Create item',exact:true}).click();
    await expect(item).toHaveCount(0);
    await inventoryRow(page,ingredientName).getByRole('button',{name:'Adjust',exact:true}).click();
    const adjustment=page.getByRole('dialog',{name:'Adjust inventory',exact:true});
    await adjustment.getByLabel(/^Quantity change/).fill('1');
    await adjustment.getByLabel('Reason',{exact:true}).fill('Offline verified opening count');
    await adjustment.getByRole('button',{name:'Record adjustment',exact:true}).click();
    await expect(adjustment).toHaveCount(0);
    await expect(inventoryRow(page,ingredientName).locator('td').nth(2)).toHaveText('11 kg');

    await navigate(page,'Purchases');
    await page.getByRole('button',{name:'Add purchase',exact:true}).click();
    const purchase=page.getByRole('dialog',{name:'Record a purchase',exact:true});
    await purchase.getByRole('combobox',{name:/^Supplier/}).selectOption({label:supplierName});
    await purchase.getByLabel('Invoice number',{exact:true}).fill('OFFLINE-KITCHEN-001');
    await purchase.getByRole('combobox',{name:/^Item/}).selectOption(ingredientId);
    await purchase.getByLabel('Quantity',{exact:true}).fill('5');
    await purchase.getByLabel('Unit price',{exact:true}).fill('120');
    await purchase.getByRole('button',{name:'Receive purchase',exact:true}).click();
    await expect(purchase).toHaveCount(0);
    await expect(page.getByRole('row').filter({hasText:'OFFLINE-KITCHEN-001'})).toContainText('600.00');
    await page.reload();
    await expect(page.getByRole('row').filter({hasText:'OFFLINE-KITCHEN-001'})).toContainText(supplierName);

    await navigate(page,'Production');
    await page.getByRole('row').filter({hasText:'Vegetable rice & curry'}).getByRole('button',{name:/ingredients|Set up recipe/}).click();
    const recipe=page.getByRole('dialog',{name:/^Recipe/});
    while(await recipe.getByRole('button',{name:'Remove ingredient',exact:true}).count()>1)await recipe.getByRole('button',{name:'Remove ingredient',exact:true}).last().click();
    await recipe.getByRole('combobox',{name:/^Ingredient \/ packaging/}).selectOption({label:`${ingredientName} (kg)`});
    await recipe.getByLabel('Recipe yield (portions)',{exact:true}).fill('2');
    await recipe.getByRole('spinbutton',{name:/^Batch quantity/}).fill('1');
    await recipe.getByRole('button',{name:'Save recipe',exact:true}).click();
    await expect(recipe).toHaveCount(0);
    await page.getByRole('button',{name:'New batch',exact:true}).click();
    const batch=page.getByRole('dialog',{name:'New production batch',exact:true});
    await batch.getByRole('combobox',{name:/^Prepared menu item/}).selectOption('m2');
    await batch.getByLabel('Portions prepared',{exact:true}).fill('4');
    await batch.getByLabel('Batch note (optional)',{exact:true}).fill('Offline kitchen lunch batch');
    await batch.getByRole('button',{name:'Record production',exact:true}).click();
    await expect(batch).toHaveCount(0);
    await expect(page.getByRole('cell',{name:'Offline kitchen lunch batch',exact:true})).toBeVisible();

    await navigate(page,'Inventory');
    await expect(inventoryRow(page,ingredientName).locator('td').nth(2)).toHaveText('14 kg');
    await page.getByRole('button',{name:'Record wastage',exact:true}).click();
    const waste=page.getByRole('dialog',{name:'Record wastage',exact:true});
    await waste.getByRole('combobox',{name:/^Stock item/}).selectOption(ingredientId);
    await waste.getByLabel('Quantity wasted (stock unit)',{exact:true}).fill('.5');
    await waste.getByRole('combobox',{name:/^Reason/}).selectOption({label:'Damaged / spilled'});
    await waste.getByLabel('Details (optional)',{exact:true}).fill('Offline damaged rice bag');
    await waste.getByRole('button',{name:'Record stock loss',exact:true}).click();
    await expect(waste).toHaveCount(0);
    await page.reload();
    await expect(inventoryRow(page,ingredientName).locator('td').nth(2)).toHaveText('13.5 kg');
    await expect(page.getByRole('region',{name:'Wastage and spoilage log'})).toContainText('Offline damaged rice bag');
    expect((await store.get(source.sourceId))!.records).toEqual(before.records);

    await counter.setOffline(false);
    await expect.poll(async()=>{
      const cloud=(await store.get(source.sourceId))!;
      return cloud.records[recordKey('inventory',ingredientId)]?.value.quantity;
    },{timeout:30000}).toBe(13.5);
    const assertCloud=(cloud:Projection)=>{
      const suppliers=records(cloud,'supplier').filter(row=>row.value.name===supplierName);
      expect(suppliers).toHaveLength(1);
      expect(suppliers[0].value).toMatchObject({phone:'0773344556',email:'offline@example.test',balance:60000});
      expect(cloud.records[recordKey('inventory',ingredientId)].value).toMatchObject({name:ingredientName,quantity:13.5,unit:'kg',minimum:2,unitCost:10625,supplierId:suppliers[0].id});
      const purchases=records(cloud,'purchase').filter(row=>row.value.invoiceNumber==='OFFLINE-KITCHEN-001');
      expect(purchases).toHaveLength(1);
      expect(purchases[0].value).toMatchObject({supplierId:suppliers[0].id,total:60000,status:'received',lines:[{itemId:ingredientId,quantity:5,unitCost:12000,total:60000}]});
      expect(cloud.records[recordKey('recipe','m2')].value).toMatchObject({batchYield:2,ingredients:[{key:'offline-batch-rice',quantity:.5}]});
      const batches=records(cloud,'production').filter(row=>row.value.note==='Offline kitchen lunch batch');
      expect(batches).toHaveLength(1);
      expect(batches[0].value).toMatchObject({menuItemId:'m2',quantity:4,cost:21250});
      expect(cloud.records[recordKey('inventory','b1-prepared-m2')].value).toMatchObject({quantity:54,unitCost:15208});
      const movements=records(cloud,'movement').filter(row=>row.value.itemId===ingredientId);
      expect(movements.map(row=>({type:row.value.type,quantity:row.value.quantity})).sort((a,b)=>String(a.type).localeCompare(String(b.type)))).toEqual([
        {type:'adjustment',quantity:1},{type:'opening',quantity:10},{type:'production',quantity:-2},{type:'purchase',quantity:5},{type:'waste',quantity:-.5},
      ]);
      expect(movements.find(row=>row.value.type==='waste')!.value).toMatchObject({reason:'Damaged / spilled: Offline damaged rice bag',unitCost:10625,totalCost:5313});
    };
    assertCloud((await store.get(source.sourceId))!);
    await remote.reload();
    await navigate(remote,'Inventory');
    await expect(inventoryRow(remote,ingredientName).locator('td').nth(2)).toHaveText('13.5 kg');
    await expect(remote.getByRole('region',{name:'Wastage and spoilage log'})).toContainText('Offline damaged rice bag');
    await navigate(remote,'Purchases');
    await expect(remote.getByRole('row').filter({hasText:'OFFLINE-KITCHEN-001'})).toContainText('600.00');
    await navigate(remote,'Production');
    await expect(remote.getByRole('cell',{name:'Offline kitchen lunch batch',exact:true})).toBeVisible();
    await counter.setOffline(true);await counter.setOffline(false);await page.reload();
    await expect(inventoryRow(page,ingredientName).locator('td').nth(2)).toHaveText('13.5 kg');
    assertCloud((await store.get(source.sourceId))!);
    expect(await deviceRecords(page)).toEqual(original);
    expect(errors).toEqual([]);
  }finally{await counter.close();await other.close();await app.close();}
});

test('offline settings survive polling and saving while shift close/open and held-bill resume sync with their exact cash and stock',async({browser})=>{
  const {store,app,counter,other,page,remote,source,original,errors}=await openSharedShop(browser);
  try{
    const before=(await store.get(source.sourceId))!;
    await counter.setOffline(true);
    await page.reload();
    await navigate(page,'Settings');
    await page.getByLabel('Business name',{exact:true}).fill('Offline Renamed Kitchen');
    await page.getByLabel('Tagline',{exact:true}).fill('Saved while the connection is down');
    await page.getByRole('textbox',{name:/^Receipt footer/}).fill('Offline receipt footer');
    // Cross the normal five-second snapshot refresh without editing again.
    await page.waitForTimeout(6500);
    await expect(page.getByLabel('Business name',{exact:true})).toHaveValue('Offline Renamed Kitchen');
    await expect(page.getByLabel('Tagline',{exact:true})).toHaveValue('Saved while the connection is down');
    await expect(page.getByRole('textbox',{name:/^Receipt footer/})).toHaveValue('Offline receipt footer');
    await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await expect(page.getByText('Business settings saved',{exact:true})).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Business name',{exact:true})).toHaveValue('Offline Renamed Kitchen');
    await expect(page.getByRole('textbox',{name:/^Receipt footer/})).toHaveValue('Offline receipt footer');

    await navigate(page,'Day end & expenses');
    await page.getByRole('button',{name:'Close & reconcile',exact:true}).click();
    const close=page.getByRole('dialog',{name:'Close & reconcile shift',exact:true});
    await close.getByRole('spinbutton',{name:/^Counted cash \(LKR\)/}).fill('0');
    await close.getByRole('button',{name:'Close shift',exact:true}).click();
    await expect(close).toHaveCount(0);
    await page.getByRole('button',{name:'Open cash shift',exact:true}).click();
    const open=page.getByRole('dialog',{name:'Open a cash shift',exact:true});
    await open.getByLabel('Opening float (LKR)',{exact:true}).fill('250');
    await open.getByRole('button',{name:'Open shift',exact:true}).click();
    await expect(open).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.cash-shift-banner')).toContainText('250.00');

    await navigate(page,'Point of sale');
    await page.getByRole('button',{name:'Add Chicken rice & curry',exact:true}).click();
    await page.getByRole('button',{name:'Takeaway',exact:true}).click();
    await page.getByRole('button',{name:/^Hold bill/}).click();
    const hold=page.getByRole('dialog',{name:'Hold bill',exact:true});
    await hold.getByLabel('Bill label',{exact:true}).fill('Offline held lunch');
    await hold.getByRole('button',{name:'Hold bill',exact:true}).click();
    await expect(hold).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Charge order',exact:true})).toBeDisabled();
    await navigate(page,'Held bills');
    await page.reload();
    const held=page.locator('article').filter({hasText:'Offline held lunch'});
    await expect(held).toContainText('650.00');
    await expect(held.getByRole('button',{name:'Resume bill',exact:true})).toBeEnabled();
    await held.getByRole('button',{name:'Resume bill',exact:true}).click();
    await expect(page.locator('.order-total')).toContainText('650.00');
    await page.getByRole('button',{name:'Charge order',exact:true}).click();
    const payment=page.getByRole('dialog',{name:'Take payment',exact:true});
    await payment.getByRole('button',{name:'Confirm payment',exact:true}).click();
    const receipt=page.getByRole('dialog',{name:'Order receipt',exact:true});
    await expect(receipt).toContainText('Offline Renamed Kitchen');
    await expect(receipt).toContainText('Offline receipt footer');
    const number=(await receipt.locator('.modal-header p').innerText()).trim();
    await receipt.getByRole('button',{name:'Close',exact:true}).click();
    await navigate(page,'Held bills');
    await expect(page.getByText('No bills on hold',{exact:true})).toBeVisible();
    await page.reload();
    await expect(page.getByText('No bills on hold',{exact:true})).toBeVisible();
    expect((await store.get(source.sourceId))!.records).toEqual(before.records);
    expect((await store.get(source.sourceId))!.metadata).toEqual(before.metadata);

    await counter.setOffline(false);
    await expect.poll(async()=>{
      const cloud=(await store.get(source.sourceId))!;
      return records(cloud,'order').filter(row=>row.value.number===number&&row.value.paymentStatus==='paid').length;
    },{timeout:30000}).toBe(1);
    const assertCloud=(cloud:Projection)=>{
      expect(cloud.metadata.settings).toMatchObject({businessName:'Offline Renamed Kitchen',tagline:'Saved while the connection is down',receiptFooter:'Offline receipt footer'});
      expect(cloud.records[recordKey('shift','b1-shift-demo')].value).toMatchObject({status:'closed',countedCash:0,expectedCash:0,variance:0});
      expect(records(cloud,'shift')).toHaveLength(2);
      expect(records(cloud,'shift').filter(row=>row.value.status==='open')).toHaveLength(1);
      expect(records(cloud,'shift').find(row=>row.value.status==='open')!.value).toMatchObject({openingFloat:25000,expectedCash:90000,countedCash:null});
      const orders=records(cloud,'order').filter(row=>row.value.number===number);
      expect(orders).toHaveLength(1);
      expect(orders[0].value).toMatchObject({paymentStatus:'paid',total:65000,paid:65000,payments:[{method:'cash',amount:65000}]});
      const held=records(cloud,'held').filter(row=>row.value.label==='Offline held lunch');
      expect(held).toHaveLength(1);
      expect(held[0].value).toMatchObject({status:'resumed',resumedOrderId:orders[0].id});
      expect(cloud.records[recordKey('inventory','b1-prepared-m1')].value.quantity).toBe(49);
    };
    assertCloud((await store.get(source.sourceId))!);
    await remote.reload();
    await navigate(remote,'Settings');
    await expect(remote.getByLabel('Business name',{exact:true})).toHaveValue('Offline Renamed Kitchen');
    await navigate(remote,'Day end & expenses');
    await expect(remote.locator('.management-stats').getByText('Rs. 900.00',{exact:true})).toBeVisible();
    await navigate(remote,'Sales history');
    await expect(remote.getByRole('row').filter({hasText:number})).toContainText('650.00');
    await navigate(remote,'Held bills');
    await expect(remote.getByText('No bills on hold',{exact:true})).toBeVisible();
    await counter.setOffline(true);await counter.setOffline(false);await page.reload();
    await expect(page.getByText('No bills on hold',{exact:true})).toBeVisible();
    assertCloud((await store.get(source.sourceId))!);
    expect(await deviceRecords(page)).toEqual(original);
    expect(errors).toEqual([]);
  }finally{await counter.close();await other.close();await app.close();}
});

test('settings typed during a pending save remain editable and save separately without losing later changes',async({browser})=>{
  const {store,app,counter,other,page,remote,source,original,errors}=await openSharedShop(browser);
  let releaseResponse=()=>{};
  const responseGate=new Promise<void>(resolve=>{releaseResponse=resolve;});
  let captureSave=()=>{};
  const capturedSave=new Promise<void>(resolve=>{captureSave=resolve;});
  let held=false;
  try{
    await navigate(page,'Settings');
    const originalTagline=((await store.get(source.sourceId))!.metadata.settings as {tagline:string}).tagline;
    await page.route(/\/api\/cloud\?action=offline-commit(?:&|$)/,async route=>{
      if(held||route.request().postDataJSON().path!=='/settings'){await route.continue();return;}
      held=true;
      const response=await route.fetch();
      captureSave();
      await responseGate;
      await route.fulfill({response});
    });
    await page.getByLabel('Business name',{exact:true}).fill('First saved kitchen name');
    await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await capturedSave;
    await expect(page.getByRole('button',{name:/^Saving/})).toBeDisabled();
    await page.getByLabel('Business name',{exact:true}).fill('Later kitchen name');
    await page.getByLabel('Tagline',{exact:true}).fill('Typed while the first save was pending');
    releaseResponse();
    await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeEnabled();
    await expect(page.getByLabel('Business name',{exact:true})).toHaveValue('Later kitchen name');
    await expect(page.getByLabel('Tagline',{exact:true})).toHaveValue('Typed while the first save was pending');
    expect((await store.get(source.sourceId))!.metadata.settings).toMatchObject({businessName:'First saved kitchen name',tagline:originalTagline});

    // A normal background snapshot must also preserve both later draft fields.
    await page.waitForTimeout(6500);
    await expect(page.getByLabel('Business name',{exact:true})).toHaveValue('Later kitchen name');
    await expect(page.getByLabel('Tagline',{exact:true})).toHaveValue('Typed while the first save was pending');
    await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeEnabled();
    expect((await store.get(source.sourceId))!.metadata.settings).toMatchObject({businessName:'Later kitchen name',tagline:'Typed while the first save was pending'});
    await page.reload();
    await expect(page.getByLabel('Business name',{exact:true})).toHaveValue('Later kitchen name');
    await remote.reload();
    await navigate(remote,'Settings');
    await expect(remote.getByLabel('Business name',{exact:true})).toHaveValue('Later kitchen name');
    await expect(remote.getByLabel('Tagline',{exact:true})).toHaveValue('Typed while the first save was pending');
    expect(await deviceRecords(page)).toEqual(original);
    expect(errors).toEqual([]);
  }finally{releaseResponse();await counter.close();await other.close();await app.close();}
});
