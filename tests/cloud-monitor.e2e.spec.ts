import {test,expect,type Page} from '@playwright/test';
import staticPlugin from '@fastify/static';
import {resolve} from 'node:path';
import {createApp} from '../server/app';
import {MemoryMonitorStore,recordKey} from '../server/monitor/store';
import type {Snapshot} from '../shared/types';

test.setTimeout(150000);
const email='cloud-owner@example.test',password='browser-cloud-secret-1927';
async function nav(page:Page,name:string){await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:new RegExp(`^${name}`)}).click();}

test('shop device uploads to a private live phone view, then two shared POS devices cannot oversell the last item',async({browser})=>{
  const store=new MemoryMonitorStore();
  const app=await createApp({databasePath:':memory:',seed:true,monitor:{store,env:{CLOUD_OWNER_EMAIL:email,CLOUD_OWNER_PASSWORD:password,CLOUD_SESSION_SECRET:'b'.repeat(64)}}});
  await app.register(staticPlugin,{root:resolve('dist'),wildcard:false});
  const origin=await app.listen({host:'127.0.0.1',port:0});
  const counter=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),phone=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await counter.newPage(),remote=await phone.newPage();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));remote.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto(origin);await page.getByRole('button',{name:'Set up this device',exact:true}).click();
    const setup=page.getByRole('dialog',{name:'Set up this device',exact:true});
    await setup.getByLabel('Business name',{exact:true}).fill('Connected Test Hotel');
    await setup.getByLabel('Owner name',{exact:true}).fill('Cloud Test Owner');
    await setup.getByLabel(/^Owner PIN/).fill('98765432');await setup.getByLabel('Confirm owner PIN',{exact:true}).fill('98765432');
    await setup.getByRole('checkbox',{name:/^Include sample menu/}).check();await setup.getByRole('button',{name:'Create device workspace',exact:true}).click();
    await expect(page.getByRole('button',{name:'Add Chicken rice & curry',exact:true})).toBeVisible();
    await nav(page,'Settings');
    await page.getByLabel('Cloud owner email',{exact:true}).fill(email);await page.getByLabel('Cloud owner password',{exact:true}).fill(password);
    await page.getByLabel('Device label',{exact:true}).fill('Counter one');await page.getByRole('button',{name:'Connect this shop device',exact:true}).click();
    await expect(page.getByRole('button',{name:'Sync now',exact:true})).toBeVisible();await expect(page.locator('.cloud-summary')).toContainText('0 changes waiting');
    const [source]=await store.list();expect(source.ready).toBe(true);
    await remote.goto(`${origin}/?cloud=1`);await remote.getByLabel('Cloud owner email',{exact:true}).fill(email);await remote.getByLabel('Cloud owner password',{exact:true}).fill(password);await remote.getByRole('button',{name:'Open cloud workspace',exact:true}).click();
    await expect(remote.getByRole('heading',{level:1,name:'Owner live view',exact:true})).toBeVisible();
    await expect(remote.getByRole('combobox',{name:'Cloud workspace',exact:true})).toContainText('Connected Test Hotel');
    await nav(page,'Point of sale');await page.getByRole('button',{name:'Add Ceylon milk tea',exact:true}).click();await page.getByRole('button',{name:'Charge order',exact:true}).click();
    await page.getByRole('dialog',{name:'Take payment',exact:true}).getByRole('button',{name:'Confirm payment',exact:true}).click();
    await page.getByRole('dialog',{name:'Order receipt',exact:true}).getByRole('button',{name:'Close',exact:true}).click();
    await expect.poll(async()=>Object.values((await store.get(source.sourceId))!.records).filter(row=>row.kind==='order').length).toBe(1);
    await remote.getByRole('button',{name:'Refresh cloud view',exact:true}).click();
    await expect(remote.locator('.cloud-table')).toContainText('Ceylon milk tea');
    await remote.getByRole('button',{name:'Stock',exact:true}).click();await expect(remote.locator('table')).toContainText('Samba rice');
    expect(await remote.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await remote.screenshot({path:'artifacts/cloud-phone-live.png',fullPage:true});
    await remote.getByRole('button',{name:'Reports',exact:true}).click();const downloaded=remote.waitForEvent('download');await remote.getByRole('button',{name:'Download profit report',exact:true}).click();expect((await downloaded).suggestedFilename()).toMatch(/^profit-/);
    await remote.getByRole('checkbox',{name:/^I have exported a backup/}).check();await remote.getByRole('button',{name:'Enable shared POS',exact:true}).click();
    await expect(remote.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();
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
    const winner=await firstPayment.count()?firstPayment:otherPayment;await winner.getByRole('button',{name:'Confirm payment',exact:true}).click();
    const final=(await store.get(source.sourceId))!;expect(Object.values(final.records).filter(row=>row.kind==='order'&&row.value.paymentStatus==='paid')).toHaveLength(2);
    expect(errors).toEqual([]);
  }finally{await counter.close();await phone.close();await app.close();}
});
