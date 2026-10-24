import {test,expect,type Page} from '@playwright/test';
import staticPlugin from '@fastify/static';
import {resolve} from 'node:path';
import {createApp} from '../server/app';
import {MemoryMonitorStore} from '../server/monitor/store';

test.setTimeout(150000);
const pin='98765432';
async function nav(page:Page,name:string){const open=page.getByRole('button',{name:'Open navigation',exact:true});if(await open.isVisible())await open.click();await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:new RegExp(`^${name}`)}).click();}
async function signIn(page:Page){await page.getByLabel('Staff PIN',{exact:true}).fill(pin);await page.getByRole('button',{name:'Open workspace',exact:true}).click();await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();}

test('one PIN opens the same live POS on a phone and counter, and concurrent devices cannot oversell the last item',async({browser})=>{
  const store=new MemoryMonitorStore();
  const app=await createApp({databasePath:':memory:',seed:true,monitor:{store,env:{CLOUD_POS_PIN:pin,CLOUD_SESSION_SECRET:'b'.repeat(64)}}});
  await app.register(staticPlugin,{root:resolve('dist'),wildcard:false});
  const origin=await app.listen({host:'127.0.0.1',port:0});
  const counter=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),phone=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await counter.newPage(),remote=await phone.newPage();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));remote.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto(`${origin}/?local=1`);await page.getByRole('button',{name:'Set up this device',exact:true}).click();
    const setup=page.getByRole('dialog',{name:'Set up this device',exact:true});
    await setup.getByLabel('Business name',{exact:true}).fill('Connected Test Hotel');
    await setup.getByLabel('Owner name',{exact:true}).fill('Cloud Test Owner');
    await setup.getByLabel(/^Owner PIN/).fill('98765432');await setup.getByLabel('Confirm owner PIN',{exact:true}).fill('98765432');
    await setup.getByRole('checkbox',{name:/^Include sample menu/}).check();await setup.getByRole('button',{name:'Create device workspace',exact:true}).click();
    await expect(page.getByRole('button',{name:'Add Chicken rice & curry',exact:true})).toBeVisible();
    await page.goto(origin);
    await signIn(page);
    await nav(page,'Settings');await expect(page.getByRole('button',{name:'Connect this shop device',exact:true})).toHaveCount(0);
    const [source]=await store.list();expect(source.ready).toBe(true);
    await remote.goto(`${origin}/?cloud=1`);await signIn(remote);
    await expect(remote).toHaveURL(new RegExp(`shared=${source.sourceId}`));
    await expect(remote.getByLabel('Cloud owner email',{exact:true})).toHaveCount(0);
    await expect(remote.getByRole('combobox',{name:'Cloud workspace',exact:true})).toHaveCount(0);
    await nav(page,'Point of sale');await page.getByRole('button',{name:'Add Ceylon milk tea',exact:true}).click();await page.getByRole('button',{name:'Charge order',exact:true}).click();
    await page.getByRole('dialog',{name:'Take payment',exact:true}).getByRole('button',{name:'Confirm payment',exact:true}).click();
    await page.getByRole('dialog',{name:'Order receipt',exact:true}).getByRole('button',{name:'Close',exact:true}).click();
    await expect.poll(async()=>Object.values((await store.get(source.sourceId))!.records).filter(row=>row.kind==='order').length).toBe(1);
    const sale=Object.values((await store.get(source.sourceId))!.records).find(row=>row.kind==='order')!;
    await nav(remote,'Sales history');
    await remote.getByRole('textbox',{name:'Search orders',exact:true}).fill('Ceylon milk tea');
    await expect(remote.getByText(String(sale.value.number),{exact:true})).toBeVisible();
    await nav(remote,'Inventory');await expect(remote.getByRole('cell',{name:/^Samba rice /}).first()).toBeVisible();
    expect(await remote.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await remote.screenshot({path:'artifacts/cloud-phone-live.png',fullPage:true});
    await nav(remote,'Reports');const downloaded=remote.waitForEvent('download');await remote.getByRole('button',{name:'Profit CSV',exact:true}).click();expect((await downloaded).suggestedFilename()).toMatch(/^profit-/);
    await nav(remote,'Point of sale');
    await remote.goto(origin);await expect(remote).toHaveURL(new RegExp(`shared=${source.sourceId}`));await expect(remote.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();
    await page.goto(`${origin}/?shared=${source.sourceId}`);await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();
    await nav(page,'Products');await page.getByRole('button',{name:'Add product',exact:true}).click();
    const product=page.getByRole('dialog',{name:'Add product',exact:true});await product.getByLabel('Product name',{exact:true}).fill('Shared last item');await product.getByLabel('Selling price (LKR)',{exact:true}).fill('500');await product.getByLabel('Cost per unit (LKR)',{exact:true}).fill('200');await product.getByLabel('Opening stock quantity',{exact:true}).fill('1');await product.getByRole('button',{name:'Add product',exact:true}).click();await expect(product).toHaveCount(0);
    await nav(page,'Point of sale');await remote.setViewportSize({width:1440,height:1000});await remote.getByRole('button',{name:'Refresh workspace',exact:true}).click();
    await expect(remote.getByRole('button',{name:'Add Shared last item',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Add Shared last item',exact:true}).click();await remote.getByRole('button',{name:'Add Shared last item',exact:true}).click();
    await Promise.all([page.getByRole('button',{name:'Charge order',exact:true}).click(),remote.getByRole('button',{name:'Charge order',exact:true}).click()]);
    await expect.poll(async()=>Object.values((await store.get(source.sourceId))!.records).filter(row=>row.kind==='order').length).toBe(2);
    const projection=(await store.get(source.sourceId))!,menu=Object.values(projection.records).find(row=>row.kind==='menu'&&row.value.name==='Shared last item')!;
    const linked=Object.values(projection.records).find(row=>row.kind==='inventory'&&row.value.menuItemId===menu.id)!;expect(linked.value.quantity).toBe(0);
    const firstPayment=page.getByRole('dialog',{name:'Take payment',exact:true}),otherPayment=remote.getByRole('dialog',{name:'Take payment',exact:true});
    await expect.poll(async()=>await firstPayment.count()+await otherPayment.count()).toBe(1);
    const winnerPage=await firstPayment.count()?page:remote;
    await winnerPage.getByRole('dialog',{name:'Take payment',exact:true}).getByRole('button',{name:'Confirm payment',exact:true}).click();
    await expect(winnerPage.getByRole('dialog',{name:'Order receipt',exact:true})).toBeVisible();
    await expect.poll(async()=>Object.values((await store.get(source.sourceId))!.records).filter(row=>row.kind==='order'&&row.value.paymentStatus==='paid').length).toBe(2);
    const final=(await store.get(source.sourceId))!;expect(Object.values(final.records).filter(row=>row.kind==='order'&&row.value.paymentStatus==='paid')).toHaveLength(2);
    for(const current of [page,remote]){const receipt=current.getByRole('dialog',{name:'Order receipt',exact:true});if(await receipt.count())await receipt.getByRole('button',{name:'Close',exact:true}).click();}
    await remote.getByRole('button',{name:'Sign out',exact:true}).click();
    await expect(remote.getByLabel('Staff PIN',{exact:true})).toBeVisible();
    await expect(remote.getByLabel('Cloud owner email',{exact:true})).toHaveCount(0);
    await expect(remote.getByRole('combobox',{name:'Cloud workspace',exact:true})).toHaveCount(0);
    expect(errors).toEqual([]);
  }finally{await counter.close();await phone.close();await app.close();}
});
