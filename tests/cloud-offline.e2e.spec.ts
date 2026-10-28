import {test,expect,type Browser,type BrowserContext,type Page} from '@playwright/test';
import staticPlugin from '@fastify/static';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {createApp} from '../server/app';
import {MemoryMonitorStore,recordKey,type Projection} from '../server/monitor/store';
import type {Customer,Order} from '../shared/types';

test.setTimeout(150_000);
test.use({actionTimeout:15000});
const pin='98765432';
const printCounter='cloud-offline-e2e-print-count';

test('a prepared browser opens the normal app address and local reports before stalled cloud replies, then starts fully offline',async({browser})=>{
  const {app,origin,counter,phone,page,errors}=await openSharedShop(browser);
  let release=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const actions:string[]=[];
  try{
    await page.route('**/api/cloud?**',async route=>{
      actions.push(new URL(route.request().url()).searchParams.get('action')??'');
      await gate;
      await route.abort('internetdisconnected').catch(()=>{});
    });
    const started=Date.now();
    await page.goto(origin);
    await expect(page.getByRole('button',{name:'Add Chicken rice & curry',exact:true})).toBeVisible({timeout:3000});
    const openingMs=Date.now()-started;
    expect(openingMs).toBeLessThan(3000);
    await expect(page.getByLabel('Staff PIN',{exact:true})).toHaveCount(0);
    expect(actions).not.toContain('workspace');
    const reportsStarted=Date.now();
    await navigate(page,'Reports');
    const download=page.waitForEvent('download');
    await page.getByRole('button',{name:'Profit CSV',exact:true}).click();
    await download;
    expect(Date.now()-reportsStarted).toBeLessThan(3000);
    expect(actions.every(action=>['pos-session','bootstrap'].includes(action))).toBe(true);

    await counter.setOffline(true);
    const reopened=await counter.newPage();
    reopened.on('pageerror',error=>errors.push(error.message));
    await reopened.goto(origin);
    await expect(reopened.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();
    expect(await reopened.evaluate(()=>navigator.onLine)).toBe(false);
    await navigate(reopened,'Reports');
    await expect(reopened.getByRole('button',{name:'Profit CSV',exact:true})).toBeEnabled();
    await navigate(reopened,'Point of sale');
    await expect(reopened.getByRole('button',{name:'Add Chicken rice & curry',exact:true})).toBeEnabled();
    expect(errors).toEqual([]);
  }finally{release();await counter.close();await phone.close();await app.close();}
});

async function navigate(page:Page,name:string){
  const open=page.getByRole('button',{name:'Open navigation',exact:true});
  if(await open.isVisible())await open.click();
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:new RegExp(`^${name}`)}).click();
}
async function refreshPhone(page:Page){await page.reload();await expect(page.getByRole('button',{name:'Open navigation',exact:true})).toBeVisible();}

async function signIn(page:Page){
  await page.getByLabel('Staff PIN',{exact:true}).fill(pin);
  await page.getByRole('button',{name:'Open workspace',exact:true}).click();
  await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();
}

async function originalRecords(page:Page){
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

async function openSharedShop(browser:Browser){
  const store=new MemoryMonitorStore();
  const app=await createApp({databasePath:':memory:',seed:true,monitor:{store,env:{CLOUD_POS_PIN:pin,CLOUD_SESSION_SECRET:'o'.repeat(64)}}});
  await app.register(staticPlugin,{root:resolve('dist'),wildcard:false});
  const origin=await app.listen({host:'127.0.0.1',port:0});
  const counter=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'allow'});
  const phone=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await counter.newPage(),remote=await phone.newPage(),errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  remote.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    // This verifies the browser print entry point without addressing real hardware.
    window.print=()=>localStorage.setItem('cloud-offline-e2e-print-count',String(Number(localStorage.getItem('cloud-offline-e2e-print-count')||0)+1));
  });
  try{
  await page.goto(`${origin}/?local=1`);
  await page.getByRole('button',{name:'Set up this device',exact:true}).click();
  const setup=page.getByRole('dialog',{name:'Set up this device',exact:true});
  await setup.getByLabel('Business name',{exact:true}).fill('Offline Shared Hotel');
  await setup.getByLabel('Owner name',{exact:true}).fill('Counter Owner');
  await setup.getByLabel(/^Owner PIN/).fill(pin);
  await setup.getByLabel('Confirm owner PIN',{exact:true}).fill(pin);
  await setup.getByRole('checkbox',{name:/^Include sample menu/}).check();
  await setup.getByRole('button',{name:'Create device workspace',exact:true}).click();
  await expect(page.getByRole('button',{name:'Add Chicken rice & curry',exact:true})).toBeVisible();
  const original=await originalRecords(page);
  await page.goto(origin);await signIn(page);
  const source=(await store.list()).find(source=>source.ready&&source.shared)!;
  expect(source).toBeDefined();
  await expect(page).toHaveURL(new RegExp(`shared=${source.sourceId}`));
  await expect(page.getByRole('combobox',{name:'Cloud workspace',exact:true})).toHaveCount(0);
  await expect(page.getByLabel('Cloud owner email',{exact:true})).toHaveCount(0);
  await remote.goto(origin);await signIn(remote);
  await expect(remote).toHaveURL(new RegExp(`shared=${source.sourceId}`));
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await page.reload();
  await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);
  return {store,app,origin,counter,phone,page,remote,source,original,errors};
  }catch(error){await counter.close();await phone.close();await app.close();throw error;}
}

async function cashSale(page:Page){
  await navigate(page,'Point of sale');
  await page.getByRole('button',{name:'Add Chicken rice & curry',exact:true}).click();
  const viewOrder=page.getByRole('button',{name:/^View order/});
  if(await viewOrder.isVisible())await viewOrder.click();
  await page.getByRole('button',{name:'Takeaway',exact:true}).click();
  await expect(page.getByRole('button',{name:'Charge order',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Charge order',exact:true}).click();
  const payment=page.getByRole('dialog',{name:'Take payment',exact:true});
  await expect(payment).toBeVisible();
  await payment.getByRole('button',{name:'Confirm payment',exact:true}).click();
  const receipt=page.getByRole('dialog',{name:'Order receipt',exact:true});
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText('PAID');
  const number=(await receipt.locator('.modal-header p').innerText()).trim();
  return {receipt,number};
}

function paidOrders(projection:Projection){
  return Object.values(projection.records).filter(row=>row.kind==='order'&&row.value.paymentStatus==='paid').map(row=>row.value as unknown as Order);
}

test('the whole offline cart scrolls to payment on short desktops, tablets and phones with large text and both discounts',async({browser})=>{
  const {app,counter,phone,page,errors}=await openSharedShop(browser);
  try{
    await navigate(page,'Settings');
    await page.getByRole('slider',{name:'Font size',exact:true}).press('End');
    await navigate(page,'Point of sale');
    await counter.setOffline(true);
    await expect(page.locator('.notice-banner')).toContainText('Working offline');
    await page.getByRole('button',{name:'Add Cappuccino',exact:true}).click();
    await page.getByRole('button',{name:'Add Watalappan',exact:true}).click();
    await page.getByRole('button',{name:'Discount Cappuccino',exact:true}).click();
    const item=page.getByRole('dialog',{name:'Item discount',exact:true});
    await item.getByLabel('Discount amount (LKR)',{exact:true}).fill('20');
    await item.getByRole('button',{name:'Apply discount',exact:true}).click();
    await page.getByRole('button',{name:'Add cart discount',exact:true}).click();
    const discount=page.getByRole('dialog',{name:'Cart discount',exact:true});
    await discount.getByLabel('Discount amount (LKR)',{exact:true}).fill('100');
    await discount.getByRole('button',{name:'Apply discount',exact:true}).click();
    await expect(page.locator('.order-total')).toContainText('510.00');
    const panel=page.getByRole('complementary',{name:'Current order',exact:true});
    const charge=panel.getByRole('button',{name:'Charge order',exact:true});
    const kitchen=panel.getByRole('button',{name:'Send to kitchen',exact:true});
    const loan=panel.getByRole('button',{name:/^Customer Loan/});
    const insideViewport=()=>panel.locator('.checkout-button,.credit-sale-button,.send-kitchen-button').evaluateAll(buttons=>buttons.length===3&&buttons.every(button=>{
      const box=button.getBoundingClientRect();
      return box.width>0&&box.top>=64&&box.bottom<=innerHeight&&box.left>=0&&box.right<=innerWidth;
    }));
    for(const longCart of [false,true]){
      if(longCart){
        await page.setViewportSize({width:1440,height:1000});
        const close=page.getByRole('button',{name:'Close order',exact:true});
        if(await close.isVisible())await close.click();
        for(const button of (await page.locator('.product-card .product-add').all()).slice(0,8))await button.click();
      }
      for(const size of [{width:1920,height:998},{width:1366,height:768},{width:1280,height:600},{width:1024,height:600},{width:820,height:1180},{width:390,height:844},{width:740,height:390}]){
        await page.setViewportSize(size);
        const view=page.getByRole('button',{name:/^View order/});
        if(await view.isVisible()&&!await panel.isVisible())await view.click();
        await page.evaluate(()=>window.scrollTo(0,0));
        await panel.evaluate(element=>{element.scrollTop=0;});
        const box=(await panel.boundingBox())!;
        await page.mouse.move(box.x+box.width/2,Math.min(size.height-30,Math.max(100,box.y+40)));
        // Real wheel input must reach the footer without Playwright scrolling a
        // hidden button into view on the user's behalf.
        await expect.poll(async()=>{
          if(await insideViewport())return true;
          await page.mouse.wheel(0,650);return false;
        },{timeout:10000,intervals:[100,200,300]}).toBe(true);
        await expect(charge).toBeEnabled();await expect(loan).toBeEnabled();await expect(kitchen).toBeEnabled();
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        const visible=(await panel.boundingBox())!;
        expect(visible.y+visible.height).toBeLessThanOrEqual(size.height+1);
        if(!longCart&&size.width===1920)await page.screenshot({path:'artifacts/cart-layout-desktop.png'});
        if(longCart&&size.width===390)await page.screenshot({path:'artifacts/cart-layout-phone.png'});
      }
    }
    await charge.click();
    const payment=page.getByRole('dialog',{name:'Take payment',exact:true});
    await expect(payment).toBeVisible();
    await payment.getByRole('button',{name:'Confirm payment',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'Order receipt',exact:true})).toBeVisible();
    expect(errors).toEqual([]);
  }finally{await counter.close();await phone.close();await app.close();}
});

test('the same verified staff PIN logs in offline after logout and reload without exposing credentials to Firebase',async({browser})=>{
  const {store,app,counter,phone,page,source,errors}=await openSharedShop(browser);
  try{
    await counter.setOffline(true);await page.reload();
    await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();
    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    await expect(page.getByLabel('Staff PIN',{exact:true})).toBeVisible();
    await page.getByLabel('Staff PIN',{exact:true}).fill('11111111');
    await page.getByRole('button',{name:'Open workspace',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('PIN');
    await signIn(page);
    await page.reload();await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();
    const sale=await cashSale(page);await sale.receipt.getByRole('button',{name:'Close',exact:true}).click();
    expect(paidOrders((await store.get(source.sourceId))!)).toHaveLength(0);
    await recoverConnection(counter,page);
    await expect.poll(async()=>paidOrders((await store.get(source.sourceId))!).length,{timeout:20000}).toBe(1);
    const cloud=JSON.stringify((await store.get(source.sourceId))!);
    expect(cloud).not.toMatch(/PBKDF2|cloud-offline-pin|pinUser/);
    expect(errors).toEqual([]);
  }finally{await counter.close();await phone.close();await app.close();}
});

async function stockShown(page:Page,quantity:number){
  await navigate(page,'Products');
  await expect(page.getByRole('row').filter({hasText:'Chicken rice & curry'}).locator('.product-stock strong')).toHaveText(`${quantity} portions`);
}

async function recoverConnection(context:BrowserContext,page:Page){
  await context.setOffline(false);
  await expect.poll(()=>page.evaluate(()=>navigator.onLine)).toBe(true);
}

test('shared POS prints and retains an offline bill, then merges it once after a lost acknowledgement and another device sale',async({browser})=>{
  const {store,app,counter,phone,page,remote,source,original,errors}=await openSharedShop(browser);
  try{
    const before=(await store.get(source.sourceId))!;
    expect(before.records[recordKey('inventory','b1-prepared-m1')].value.quantity).toBe(50);
    await counter.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();
    expect(await page.evaluate(()=>navigator.onLine)).toBe(false);
    const offline=await cashSale(page);
    await offline.receipt.getByRole('button',{name:'Print receipt',exact:true}).click();
    expect(await page.evaluate(key=>localStorage.getItem(key),printCounter)).toBe('1');
    await offline.receipt.getByRole('button',{name:'Close',exact:true}).click();
    await expect(page.getByRole('button',{name:'Charge order',exact:true})).toBeDisabled();
    await stockShown(page,49);
    expect((await store.get(source.sourceId))!.records).toEqual(before.records);

    await page.reload();
    await expect(page.getByRole('heading',{level:1,name:'Products',exact:true})).toBeVisible();
    await stockShown(page,49);
    await navigate(page,'Sales history');
    const saved=page.getByRole('row').filter({hasText:offline.number});
    await expect(saved).toContainText('650.00');
    await saved.getByRole('button',{name:'View receipt',exact:true}).click();
    const reprint=page.getByRole('dialog',{name:'Order receipt',exact:true});
    await expect(reprint).toContainText(offline.number);
    await reprint.getByRole('button',{name:'Print receipt',exact:true}).click();
    expect(await page.evaluate(key=>localStorage.getItem(key),printCounter)).toBe('2');
    await reprint.getByRole('button',{name:'Close',exact:true}).click();

    // A different device advances the cloud while the first device is offline.
    const online=await cashSale(remote);
    await online.receipt.getByRole('button',{name:'Close',exact:true}).click();
    const cloudWhileOffline=(await store.get(source.sourceId))!;
    expect(paidOrders(cloudWhileOffline)).toHaveLength(1);
    expect(cloudWhileOffline.records[recordKey('inventory','b1-prepared-m1')].value.quantity).toBe(49);

    let lostAcknowledgement=false,lostTransaction='';
    const commitRequests=new Map<string,number>();
    await page.route(/\/api\/cloud\?action=offline-commit(?:&|$)/,async route=>{
      const transactionId=String(route.request().postDataJSON().transactionId);
      commitRequests.set(transactionId,(commitRequests.get(transactionId)??0)+1);
      const response=await route.fetch();
      if(response.ok()&&!lostAcknowledgement){lostAcknowledgement=true;lostTransaction=transactionId;await route.abort('failed');return;}
      await route.fulfill({response});
    });
    await recoverConnection(counter,page);
    await expect.poll(()=>lostAcknowledgement,{timeout:20000}).toBe(true);
    // The first successful commit can lose its response before the dependent
    // payment uploads. Allow the 15 s retry cooldown and next 5 s poll to replay
    // that same command, then finish the payment without a manual refresh.
    await expect.poll(async()=>paidOrders((await store.get(source.sourceId))!).length,{timeout:40000}).toBe(2);
    // Reconnect again after the committed response was lost: the durable queue
    // must replay the same identity rather than producing a second sale.
    await counter.setOffline(true);await recoverConnection(counter,page);
    await expect.poll(()=>commitRequests.get(lostTransaction)??0,{timeout:20000}).toBeGreaterThanOrEqual(2);
    await stockShown(page,48);
    await refreshPhone(remote);
    await navigate(remote,'Sales history');
    await expect(remote.getByText(offline.number,{exact:true})).toBeVisible();
    await expect(remote.getByText(online.number,{exact:true})).toBeVisible();
    await stockShown(remote,48);
    const committed=(await store.get(source.sourceId))!;
    expect(paidOrders(committed)).toHaveLength(2);
    expect(paidOrders(committed).filter(order=>order.number===offline.number)).toHaveLength(1);
    expect(paidOrders(committed).every(order=>order.payments.length===1)).toBe(true);
    expect(committed.records[recordKey('inventory','b1-prepared-m1')].value.quantity).toBe(48);
    await counter.setOffline(true);await recoverConnection(counter,page);await page.reload();
    await stockShown(page,48);
    expect(paidOrders((await store.get(source.sourceId))!)).toHaveLength(2);
    expect(await originalRecords(page)).toEqual(original);
    expect(errors).toEqual([]);
  }finally{await counter.close();await phone.close();await app.close();}
});

test('cash paid now and the remaining loan stay separate through offline checkout, later repayments and live reports',async({browser})=>{
  const {store,app,counter,phone,page,remote,source,errors}=await openSharedShop(browser);
  try{
    const before=(await store.get(source.sourceId))!;
    const openingCash=Object.values(before.records).find(row=>row.kind==='shift'&&row.value.status==='open')!.value.expectedCash as number;
    await counter.setOffline(true);
    await page.getByRole('button',{name:'Add Chicken rice & curry',exact:true}).click();
    await page.getByRole('button',{name:/^Customer Loan/}).click();
    const customer=page.getByRole('dialog',{name:'Customer Loan',exact:true});
    await customer.getByRole('button',{name:'New customer',exact:true}).click();
    await customer.getByLabel('Customer name',{exact:true}).fill('Split Loan Guest');
    await customer.getByLabel('Phone number',{exact:true}).fill('0771122334');
    await customer.getByRole('button',{name:'Continue to loan',exact:true}).click();
    const payment=page.getByRole('dialog',{name:'Take payment',exact:true});
    await payment.getByLabel('Paid now (cash) (LKR)',{exact:true}).fill('650');
    await expect(payment.getByRole('button',{name:'Confirm cash & loan',exact:true})).toBeDisabled();
    await payment.getByLabel('Paid now (cash) (LKR)',{exact:true}).fill('200');
    const breakdown=payment.getByLabel('Cash and customer loan breakdown',{exact:true});
    await expect(breakdown.locator('div').filter({hasText:'Cash received now'})).toContainText('200.00');
    await expect(breakdown.locator('div').filter({hasText:'Remaining Customer Loan'})).toContainText('450.00');
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await payment.getByRole('checkbox').check();
    await payment.getByRole('button',{name:'Confirm cash & loan',exact:true}).click();
    const receipt=page.getByRole('dialog',{name:'Order receipt',exact:true});
    await expect(receipt).toContainText('CASH');await expect(receipt).toContainText('CREDIT');
    await expect(receipt).toContainText('200.00');await expect(receipt).toContainText('450.00');
    await receipt.getByRole('button',{name:'Close',exact:true}).click();
    await page.setViewportSize({width:1440,height:1000});
    await navigate(page,'Reports');
    const profit=page.getByRole('region',{name:'Daily profitability',exact:true});
    const loans=profit.getByRole('region',{name:'Customer loans to collect',exact:true});
    await expect(loans.getByLabel('Outstanding customer loans',{exact:true})).toHaveText('Rs. 450.00');
    await expect(loans).toHaveClass(/loan-outstanding/);
    await expect(loans.getByRole('row').filter({hasText:'Split Loan Guest'})).toContainText('0771122334');
    await expect(profit).toContainText('Bill basis');
    const initialProfit=await profit.locator('.profit-result-main strong').innerText();
    await page.screenshot({path:'artifacts/split-loan-report.png',fullPage:true});
    const download=page.waitForEvent('download');await profit.getByRole('button',{name:'Profit CSV',exact:true}).click();
    const file=await download;const csv=await readFile((await file.path())!,'utf8');
    expect(csv).toContain('Split Loan Guest');expect(csv).toContain('450.00');
    await page.reload();await expect(loans.getByLabel('Outstanding customer loans',{exact:true})).toHaveText('Rs. 450.00');
    for(const amount of ['100','350']){
      await navigate(page,'Customers & dues');
      const row=page.getByRole('row').filter({hasText:'Split Loan Guest'});
      await row.getByRole('button',{name:'Ledger & collect',exact:true}).click();
      const ledger=page.getByRole('dialog',{name:'Customer ledger & collection',exact:true});
      const received=ledger.getByRole('spinbutton',{name:'Amount received (LKR)',exact:true});
      await expect(received).toHaveValue('');
      await expect(ledger.getByRole('button',{name:'Record collection',exact:true})).toBeDisabled();
      await received.pressSequentially(amount);
      const preview=ledger.getByRole('status',{name:'Repayment preview',exact:true});
      await expect(preview.locator('div').filter({hasText:'Remaining loan after payment'})).toContainText(amount==='100'?'350.00':'0.00');
      await ledger.getByRole('button',{name:'Record collection',exact:true}).click();
      await expect(ledger).toHaveCount(0);
      await navigate(page,'Reports');
      await expect(loans.getByLabel('Outstanding customer loans',{exact:true})).toHaveText(amount==='100'?'Rs. 350.00':'Rs. 0.00');
      await expect(profit.locator('.profit-result-main strong')).toHaveText(initialProfit);
    }
    await expect(loans.locator('.loan-repayments strong')).toHaveText('Rs. 450.00');
    await recoverConnection(counter,page);
    await expect.poll(async()=>{
      const saved=(await store.get(source.sourceId))!;
      return {
        paidBills:paidOrders(saved).length,
        balance:Object.values(saved.records).find(row=>row.kind==='customer'&&row.value.name==='Split Loan Guest')?.value.balance,
        cash:Object.values(saved.records).find(row=>row.kind==='shift'&&row.value.status==='open')?.value.expectedCash,
      };
    },{timeout:20000}).toEqual({paidBills:1,balance:0,cash:openingCash+65000});
    const cloud=(await store.get(source.sourceId))!;
    const [order]=paidOrders(cloud);
    expect(order.payments.map(payment=>({method:payment.method,amount:payment.amount}))).toEqual([{method:'cash',amount:20000},{method:'credit',amount:45000}]);
    expect(Object.values(cloud.records).find(row=>row.kind==='shift'&&row.value.status==='open')!.value.expectedCash).toBe(openingCash+65000);
    await refreshPhone(remote);await navigate(remote,'Reports');
    await expect(remote.getByLabel('Outstanding customer loans',{exact:true})).toHaveText('Rs. 0.00');
    expect(errors).toEqual([]);
  }finally{await counter.close();await phone.close();await app.close();}
});

test('offline card and QR records, customer loans and electronic repayments persist and sync without adding drawer cash',async({browser})=>{
  const {store,app,counter,phone,page,remote,source,errors}=await openSharedShop(browser);
  try{
    const before=(await store.get(source.sourceId))!;
    const openingCash=Object.values(before.records).find(row=>row.kind==='shift'&&row.value.status==='open')!.value.expectedCash;
    await counter.setOffline(true);
    for(const method of ['Card','QR / Bank']){
      await page.getByRole('button',{name:'Add Chicken rice & curry',exact:true}).click();
      await page.getByRole('button',{name:'Charge order',exact:true}).click();
      const payment=page.getByRole('dialog',{name:'Take payment',exact:true});
      await payment.getByRole('button',{name:method,exact:true}).click();
      await payment.getByRole('textbox',{name:'Terminal / bank reference',exact:true}).fill(`APPROVED-${method==='Card'?'CARD':'QR'}-001`);
      await payment.getByRole('checkbox').check();
      await payment.getByRole('button',{name:'Confirm payment',exact:true}).click();
      const receipt=page.getByRole('dialog',{name:'Order receipt',exact:true});
      await expect(receipt).toContainText(method==='Card'?'CARD':'QR');
      await receipt.getByRole('button',{name:'Print receipt',exact:true}).click();
      await receipt.getByRole('button',{name:'Close',exact:true}).click();
      await page.reload();await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();
    }
    await page.getByRole('button',{name:'Add Chicken rice & curry',exact:true}).click();
    await page.getByRole('button',{name:/^Customer Loan/}).click();
    const customer=page.getByRole('dialog',{name:'Customer Loan',exact:true});
    await customer.getByRole('button',{name:'New customer',exact:true}).click();
    await customer.getByLabel('Customer name',{exact:true}).fill('Offline Electronic Guest');
    await customer.getByLabel('Phone number',{exact:true}).fill('0770102030');
    await customer.getByRole('button',{name:'Continue to loan',exact:true}).click();
    const payment=page.getByRole('dialog',{name:'Take payment',exact:true});
    await payment.getByRole('checkbox').check();await payment.getByRole('button',{name:'Confirm customer loan',exact:true}).click();
    await page.getByRole('dialog',{name:'Order receipt',exact:true}).getByRole('button',{name:'Close',exact:true}).click();
    await navigate(page,'Customers & dues');
    const row=page.getByRole('row').filter({hasText:'Offline Electronic Guest'});
    for(const [method,amount,balance] of [['card','200','450.00'],['qr','100','350.00']]){
      await row.getByRole('button',{name:'Ledger & collect',exact:true}).click();
      const ledger=page.getByRole('dialog',{name:'Customer ledger & collection',exact:true});
      await ledger.getByRole('spinbutton',{name:'Amount received (LKR)',exact:true}).fill(amount);
      await ledger.getByRole('combobox',{name:'Payment method',exact:true}).selectOption(method);
      const reference=ledger.getByRole('textbox',{name:'Approved payment reference',exact:true});
      await expect(reference).toHaveAttribute('required','');
      await reference.fill(`APPROVED-REPAYMENT-${method}`);
      await ledger.getByRole('button',{name:'Record collection',exact:true}).click();
      await expect(ledger).toHaveCount(0);await expect(row.locator('td').nth(4)).toHaveText(`Rs. ${balance}`);
    }
    await page.reload();await expect(row.locator('td').nth(4)).toHaveText('Rs. 350.00');
    expect(paidOrders((await store.get(source.sourceId))!)).toHaveLength(0);
    await recoverConnection(counter,page);
    await expect.poll(async()=>paidOrders((await store.get(source.sourceId))!).length,{timeout:30000}).toBe(3);
    await expect.poll(async()=>Object.values((await store.get(source.sourceId))!.records).find(row=>row.kind==='customer'&&row.value.name==='Offline Electronic Guest')?.value.balance,{timeout:30000}).toBe(35000);
    const saved=(await store.get(source.sourceId))!;
    expect(Object.values(saved.records).find(row=>row.kind==='shift'&&row.value.status==='open')!.value.expectedCash).toBe(openingCash);
    expect(new Set(paidOrders(saved).flatMap(order=>order.payments.map(payment=>payment.method)))).toEqual(new Set(['card','qr','credit']));
    expect(await page.evaluate(key=>localStorage.getItem(key),printCounter)).toBe('2');
    await refreshPhone(remote);await navigate(remote,'Customers & dues');
    await expect(remote.getByRole('row').filter({hasText:'Offline Electronic Guest'}).locator('td').nth(4)).toHaveText('Rs. 350.00');
    expect(errors).toEqual([]);
  }finally{await counter.close();await phone.close();await app.close();}
});

test('a stalled cloud connection does not hold up cached products, bills, reports or a prepared browser restart',async({browser})=>{
  const {store,app,counter,phone,page,remote,source,errors}=await openSharedShop(browser);
  let unavailable=true,attempts=0,stalled=false;
  try{
    await page.route('**/api/cloud?**',async route=>{
      if(!unavailable){await route.continue();return;}
      attempts++;
      if(!stalled){stalled=true;await new Promise(resolve=>setTimeout(resolve,10000));}
      await route.abort('internetdisconnected').catch(()=>{});
    });
    expect(await page.evaluate(()=>navigator.onLine)).toBe(true);
    const start=Date.now();
    await page.getByRole('button',{name:'Refresh workspace',exact:true}).click();
    await expect(page.locator('.notice-banner')).toContainText('Working offline',{timeout:5000});
    expect(Date.now()-start).toBeLessThan(5000);
    const firstAttempts=attempts;
    await page.getByRole('button',{name:'Add product',exact:true}).click();
    const product=page.getByRole('dialog',{name:'Add product',exact:true});
    await product.getByLabel('Product name',{exact:true}).fill('No Internet Product');
    await product.getByRole('combobox',{name:/^Stock tracking/}).selectOption('untracked');
    await product.getByLabel('Selling price (LKR)',{exact:true}).fill('100');
    await product.getByLabel('Cost per unit (LKR)',{exact:true}).fill('40');
    await product.getByRole('button',{name:'Add product',exact:true}).click();await expect(product).toHaveCount(0);
    await page.getByRole('button',{name:'Add No Internet Product',exact:true}).click();
    await page.getByRole('button',{name:'Charge order',exact:true}).click();
    const payment=page.getByRole('dialog',{name:'Take payment',exact:true});
    await payment.getByRole('button',{name:'Confirm payment',exact:true}).click();
    await page.getByRole('dialog',{name:'Order receipt',exact:true}).getByRole('button',{name:'Close',exact:true}).click();
    await navigate(page,'Reports');
    const download=page.waitForEvent('download');await page.getByRole('button',{name:'Profit CSV',exact:true}).click();await download;
    expect(attempts).toBe(firstAttempts);
    await page.reload();
    await expect(page.getByRole('heading',{level:1,name:/Reports/})).toBeVisible({timeout:5000});
    await expect(page.getByLabel('Staff PIN',{exact:true})).toHaveCount(0);
    expect(paidOrders((await store.get(source.sourceId))!)).toHaveLength(0);
    unavailable=false;
    await page.getByRole('button',{name:'Refresh workspace',exact:true}).click();
    await expect.poll(async()=>paidOrders((await store.get(source.sourceId))!).length,{timeout:30000}).toBe(1);
    await refreshPhone(remote);await navigate(remote,'Products');
    await expect(remote.getByRole('row').filter({hasText:'No Internet Product'})).toContainText('100.00');
    expect(errors).toEqual([]);
  }finally{await counter.close();await phone.close();await app.close();}
});

test('offline customer loans and partial repayments survive reload and appear on the other device after reconnecting',async({browser})=>{
  const {store,app,counter,phone,page,remote,source,original,errors}=await openSharedShop(browser);
  try{
    const before=(await store.get(source.sourceId))!;
    await counter.setOffline(true);
    await page.getByRole('button',{name:'Add Chicken rice & curry',exact:true}).click();
    await page.getByRole('button',{name:'Takeaway',exact:true}).click();
    await expect(page.getByRole('button',{name:/^Customer Loan/})).toBeEnabled();
    await page.getByRole('button',{name:/^Customer Loan/}).click();
    const customer=page.getByRole('dialog',{name:'Customer Loan',exact:true});
    const newCustomer=customer.getByRole('button',{name:'New customer',exact:true});
    if(await newCustomer.isVisible())await newCustomer.click();
    await customer.getByLabel('Customer name',{exact:true}).fill('Offline Loan Guest');
    await customer.getByLabel('Phone number',{exact:true}).fill('0775566778');
    await customer.getByRole('button',{name:'Continue to loan',exact:true}).click();
    const payment=page.getByRole('dialog',{name:'Take payment',exact:true});
    await expect(payment).toBeVisible();
    await payment.getByRole('checkbox').check();
    await payment.getByRole('button',{name:'Confirm customer loan',exact:true}).click();
    const receipt=page.getByRole('dialog',{name:'Order receipt',exact:true});
    await expect(receipt).toContainText('CREDIT');
    const number=(await receipt.locator('.modal-header p').innerText()).trim();
    await receipt.getByRole('button',{name:'Print receipt',exact:true}).click();
    await receipt.getByRole('button',{name:'Close',exact:true}).click();
    await expect(page.getByRole('button',{name:'Charge order',exact:true})).toBeDisabled();
    await navigate(page,'Customers & dues');
    const row=page.getByRole('row').filter({hasText:'Offline Loan Guest'});
    await expect(row).toContainText('650.00');
    await row.getByRole('button',{name:'Ledger & collect',exact:true}).click();
    const ledger=page.getByRole('dialog',{name:'Customer ledger & collection',exact:true});
    await ledger.getByRole('spinbutton',{name:'Amount received (LKR)',exact:true}).fill('200');
    await ledger.getByRole('textbox',{name:'Note (optional)',exact:true}).fill('Offline part payment');
    await ledger.getByRole('button',{name:'Record collection',exact:true}).click();
    await expect(ledger).toHaveCount(0);
    await expect(row).toContainText('450.00');
    expect((await store.get(source.sourceId))!.records).toEqual(before.records);

    await page.reload();
    await expect(row).toContainText('0775566778');
    await expect(row).toContainText('450.00');
    await row.getByRole('button',{name:'Ledger & collect',exact:true}).click();
    await expect(ledger).toContainText('Offline part payment');
    await ledger.getByRole('button',{name:'Close',exact:true}).click();
    await stockShown(page,49);
    await recoverConnection(counter,page);
    await expect.poll(async()=>{
      const projection=(await store.get(source.sourceId))!;
      return Object.values(projection.records).find(row=>row.kind==='customer'&&row.value.name==='Offline Loan Guest')?.value.balance;
    },{timeout:20000}).toBe(45000);
    await refreshPhone(remote);
    await navigate(remote,'Customers & dues');
    const remoteRow=remote.getByRole('row').filter({hasText:'Offline Loan Guest'});
    await expect(remoteRow).toContainText('0775566778');
    await expect(remoteRow).toContainText('450.00');
    await remoteRow.getByRole('button',{name:'Ledger & collect',exact:true}).click();
    await expect(remote.getByRole('dialog',{name:'Customer ledger & collection',exact:true})).toContainText('Offline part payment');
    const final=(await store.get(source.sourceId))!;
    const savedCustomer=Object.values(final.records).find(row=>row.kind==='customer'&&row.value.name==='Offline Loan Guest')!.value as unknown as Customer;
    const orders=paidOrders(final).filter(order=>order.number===number);
    expect(orders).toHaveLength(1);expect(orders[0].payments).toHaveLength(1);
    expect(orders[0].payments[0]).toMatchObject({method:'credit',amount:65000});
    expect(savedCustomer.balance).toBe(45000);
    expect(Object.values(final.records).filter(row=>row.kind==='credit'&&row.value.customerId===savedCustomer.id&&row.value.type==='collection')).toHaveLength(1);
    expect(final.records[recordKey('inventory','b1-prepared-m1')].value.quantity).toBe(49);
    expect(await originalRecords(page)).toEqual(original);
    expect(errors).toEqual([]);
  }finally{await counter.close();await phone.close();await app.close();}
});

test('offline product setup, price and stock edits, sales, expenses and profit downloads all sync to the other device',async({browser})=>{
  const {store,app,counter,phone,page,remote,source,original,errors}=await openSharedShop(browser);
  const productName='Offline Special Pack';
  const image='https://example.invalid/offline-special-pack.jpg';
  try{
    const before=(await store.get(source.sourceId))!;
    await counter.setOffline(true);
    await page.getByRole('button',{name:'Add category',exact:true}).click();
    const category=page.getByRole('dialog',{name:'Add category',exact:true});
    await category.getByLabel('Category name',{exact:true}).fill('Offline Specials');
    await category.getByRole('button',{name:'Add category',exact:true}).click();
    await expect(category).toHaveCount(0);
    await page.getByRole('button',{name:'Add product',exact:true}).click();
    const product=page.getByRole('dialog',{name:'Add product',exact:true});
    await product.getByLabel('Product name',{exact:true}).fill(productName);
    await product.getByRole('combobox',{name:'Category',exact:true}).selectOption({label:'Offline Specials'});
    await product.getByLabel('Selling price (LKR)',{exact:true}).fill('500');
    await product.getByLabel('Cost per unit (LKR)',{exact:true}).fill('200');
    await product.getByLabel('Barcode (optional)',{exact:true}).fill('8940000990011');
    await product.getByLabel('Photo URL',{exact:true}).fill(image);
    await product.getByRole('combobox',{name:'Product type',exact:true}).selectOption('resale');
    await product.getByLabel('Opening stock quantity',{exact:true}).fill('10');
    await expect(product.getByLabel('Product profit preview',{exact:true})).toContainText('300.00');
    await product.getByRole('button',{name:'Add product',exact:true}).click();
    await expect(product).toHaveCount(0);

    await navigate(page,'Products');
    const row=page.getByRole('row').filter({hasText:productName});
    await expect(row.locator('.product-stock strong')).toHaveText('10 pcs');
    await row.getByRole('button',{name:`Edit ${productName}`,exact:true}).click();
    const edit=page.getByRole('dialog',{name:'Edit product',exact:true});
    await edit.getByLabel('Selling price (LKR)',{exact:true}).fill('600');
    await edit.getByLabel('Cost per unit (LKR)',{exact:true}).fill('250');
    await edit.getByRole('spinbutton',{name:/^Counted stock \(pcs\)/}).fill('12');
    await edit.getByRole('button',{name:'Save product',exact:true}).click();
    await expect(edit).toHaveCount(0);
    await expect(row.locator('.product-stock strong')).toHaveText('12 pcs');
    await expect(row).toContainText('600.00');
    await expect(row).toContainText('250.00');

    await navigate(page,'Point of sale');
    await page.getByRole('button',{name:`Add ${productName}`,exact:true}).click();
    await page.getByRole('button',{name:'Takeaway',exact:true}).click();
    await page.getByRole('button',{name:'Charge order',exact:true}).click();
    const payment=page.getByRole('dialog',{name:'Take payment',exact:true});
    await expect(payment).toContainText('600.00');
    await payment.getByRole('button',{name:'Confirm payment',exact:true}).click();
    const receipt=page.getByRole('dialog',{name:'Order receipt',exact:true});
    await expect(receipt).toContainText(productName);
    await receipt.getByRole('button',{name:'Print receipt',exact:true}).click();
    await receipt.getByRole('button',{name:'Close',exact:true}).click();
    expect(await page.evaluate(key=>localStorage.getItem(key),printCounter)).toBe('1');
    await expect(page.getByRole('button',{name:'Charge order',exact:true})).toBeDisabled();

    await navigate(page,'Day end & expenses');
    await page.getByRole('button',{name:'Add expense',exact:true}).click();
    const expense=page.getByRole('dialog',{name:'Record an expense',exact:true});
    await expense.getByLabel('Description',{exact:true}).fill('Offline delivery expense');
    await expense.getByRole('combobox',{name:'Category',exact:true}).selectOption('transport');
    await expense.getByRole('spinbutton',{name:'Amount (LKR)',exact:true}).fill('50');
    await expense.getByRole('combobox',{name:'Payment method',exact:true}).selectOption('cash');
    await expense.getByRole('button',{name:'Record expense',exact:true}).click();
    await expect(expense).toHaveCount(0);
    await expect(page.getByRole('row').filter({hasText:'Offline delivery expense'})).toContainText('50.00');

    await navigate(page,'Reports');
    const profit=page.getByRole('region',{name:'Daily profitability',exact:true});
    await expect(profit.locator('.profit-metrics > div').filter({hasText:'Cost of sales'})).toContainText('250.00');
    await expect(profit.locator('.profit-metrics > div').filter({hasText:'Gross profit'})).toContainText('350.00');
    await expect(profit.locator('.profit-result-main strong')).toHaveText('Rs. 300.00');
    const profitDownload=page.waitForEvent('download');
    await profit.getByRole('button',{name:'Profit CSV',exact:true}).click();
    const downloaded=await profitDownload;
    expect(downloaded.suggestedFilename()).toMatch(/^profit-/);
    const csv=await readFile((await downloaded.path())!,'utf8');
    expect(csv).toContain('"TOTAL","600.00","250.00","0.00","0.00","50.00","300.00"');
    expect(csv).toContain(productName);
    const cashflowDownload=page.waitForEvent('download');
    await page.getByRole('button',{name:'Download CSV',exact:true}).click();
    const cashflow=await readFile((await (await cashflowDownload).path())!,'utf8');
    expect(cashflow).toContain('Offline delivery expense');
    expect(cashflow).toContain('600.00');
    expect((await store.get(source.sourceId))!.records).toEqual(before.records);
    await page.reload();
    await expect(profit.locator('.profit-result-main strong')).toHaveText('Rs. 300.00');

    await recoverConnection(counter,page);
    await expect.poll(async()=>{
      const projection=(await store.get(source.sourceId))!;
      return Object.values(projection.records).filter(row=>row.kind==='expense'&&row.value.description==='Offline delivery expense').length;
    },{timeout:30000}).toBe(1);
    await refreshPhone(remote);
    await navigate(remote,'Products');
    const remoteProduct=remote.getByRole('row').filter({hasText:productName});
    await expect(remoteProduct).toContainText('Offline Specials');
    await expect(remoteProduct).toContainText('600.00');
    await expect(remoteProduct).toContainText('250.00');
    await expect(remoteProduct).toContainText('8940000990011');
    await expect(remoteProduct.locator('.product-stock strong')).toHaveText('11 pcs');
    await navigate(remote,'Day end & expenses');
    await expect(remote.getByRole('row').filter({hasText:'Offline delivery expense'})).toContainText('50.00');
    await navigate(remote,'Reports');
    const remoteProfit=remote.getByRole('region',{name:'Daily profitability',exact:true});
    await expect(remoteProfit.locator('.profit-result-main strong')).toHaveText('Rs. 300.00');
    await expect(remoteProfit.getByRole('row').filter({hasText:productName})).toContainText('350.00');
    const final=(await store.get(source.sourceId))!;
    const saved=Object.values(final.records).find(row=>row.kind==='menu'&&row.value.name===productName)!;
    expect(saved.value).toMatchObject({price:60000,cost:25000,image,barcode:'8940000990011'});
    expect(Object.values(final.records).find(row=>row.kind==='inventory'&&row.value.menuItemId===saved.id)?.value).toMatchObject({quantity:11,unitCost:25000,unit:'pcs'});
    expect(paidOrders(final)).toHaveLength(1);
    expect(paidOrders(final)[0].lines[0]).toMatchObject({menuItemId:saved.id,unitPrice:60000,unitCost:25000});
    expect(await originalRecords(page)).toEqual(original);
    expect(errors).toEqual([]);
  }finally{await counter.close();await phone.close();await app.close();}
});
