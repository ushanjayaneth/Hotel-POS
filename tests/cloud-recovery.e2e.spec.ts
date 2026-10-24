import {test,expect,type Page,type BrowserContext} from '@playwright/test';
import staticPlugin from '@fastify/static';
import {resolve} from 'node:path';
import {createApp} from '../server/app';
import {MemoryMonitorStore,recordKey} from '../server/monitor/store';
import type {Customer,Order,Snapshot} from '../shared/types';

test.setTimeout(150000);
const email='recovery-owner@example.test',password='recovery-cloud-password-1927';

async function navigate(page:Page,name:string){
  const open=page.getByRole('button',{name:'Open navigation',exact:true});
  if(await open.isVisible())await open.click();
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:new RegExp(`^${name}`)}).click();
}
async function command<T>(context:BrowserContext,origin:string,sourceId:string,path:string,body:Record<string,unknown>){
  const response=await context.request.post(`${origin}/api/cloud?action=command`,{headers:{Origin:origin},data:{sourceId,path,method:'POST',body:{commandId:`recovery-${crypto.randomUUID()}`,...body}}});
  expect(response.status(),await response.text()).toBe(200);return await response.json() as T;
}
async function localDatabaseState(page:Page){
  return page.evaluate(async()=>{
    const name='demo-hotel-local-workspace-v1';
    if(!(await indexedDB.databases()).some(database=>database.name===name))return {credentials:0,records:0,workspace:false};
    return new Promise<{credentials:number;records:number;workspace:boolean}>((resolve,reject)=>{
      const opened=indexedDB.open(name);
      opened.onerror=()=>reject(opened.error);
      opened.onsuccess=()=>{
        const db=opened.result,tx=db.transaction(['credentials','records','metadata'],'readonly');
        const credentials=tx.objectStore('credentials').count(),records=tx.objectStore('records').count(),workspace=tx.objectStore('metadata').get('workspace');
        tx.oncomplete=()=>{db.close();resolve({credentials:credentials.result,records:records.result,workspace:Boolean(workspace.result)});};
        tx.onerror=()=>{db.close();reject(tx.error);};
      };
    });
  });
}

test('cleared browser data recovers the same stock, loan and bill only after cloud owner sign-in, even on a slow connection',async({browser})=>{
  const store=new MemoryMonitorStore();
  const app=await createApp({databasePath:':memory:',seed:true,monitor:{store,env:{CLOUD_OWNER_EMAIL:email,CLOUD_OWNER_PASSWORD:password,CLOUD_SESSION_SECRET:'r'.repeat(64)}}});
  await app.register(staticPlugin,{root:resolve('dist'),wildcard:false});
  const origin=await app.listen({host:'127.0.0.1',port:0});
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  const page=await context.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto(`${origin}/?local=1`);await page.getByRole('button',{name:'Set up this device',exact:true}).click();
    const setup=page.getByRole('dialog',{name:'Set up this device',exact:true});
    await setup.getByLabel('Business name',{exact:true}).fill('Recovery Test Hotel');
    await setup.getByLabel('Owner name',{exact:true}).fill('Recovery Owner');
    await setup.getByLabel(/^Owner PIN/).fill('98765432');await setup.getByLabel('Confirm owner PIN',{exact:true}).fill('98765432');
    await setup.getByRole('checkbox',{name:/^Include sample menu/}).check();await setup.getByRole('button',{name:'Create device workspace',exact:true}).click();
    await expect(page.getByRole('button',{name:'Add Chicken rice & curry',exact:true})).toBeVisible();
    expect((await localDatabaseState(page)).credentials).toBe(1);
    await page.goto(origin);
    await page.getByLabel('Cloud owner email',{exact:true}).fill(email);await page.getByLabel('Cloud owner password',{exact:true}).fill(password);
    await page.getByRole('button',{name:'Open cloud workspace',exact:true}).click();
    await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();
    const [source]=await store.list();expect(source.ready).toBe(true);
    const promotion=await context.request.post(`${origin}/api/cloud?action=promote`,{headers:{Origin:origin},data:{sourceId:source.sourceId}});expect(promotion.status()).toBe(200);
    const {customer}=await command<{customer:Customer}>(context,origin,source.sourceId,'/customers',{name:'Restored Loan Customer',phone:'0774455667',email:''});
    const {order}=await command<{order:Order}>(context,origin,source.sourceId,'/orders',{branchId:'b1',type:'takeaway',lines:[{menuItemId:'m1',quantity:2}]});
    await command(context,origin,source.sourceId,`/orders/${order.id}/payments`,{expectedVersion:order.version,method:'credit',customerId:customer.id,amount:order.total,received:order.total});
    await command(context,origin,source.sourceId,`/customers/${customer.id}/collections`,{branchId:'b1',amount:10000,method:'cash',reference:'Part payment',note:''});
    const before=(await store.get(source.sourceId))!;
    expect(before.records[recordKey('inventory','b1-prepared-m1')].value.quantity).toBe(48);
    await page.goto(`${origin}/?shared=${source.sourceId}`);
    await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();

    // Close database handles before simulating the browser's complete site-data clear.
    await page.goto('about:blank');
    const devtools=await context.newCDPSession(page);await devtools.send('Storage.clearDataForOrigin',{origin,storageTypes:'all'});await devtools.detach();
    await context.clearCookies();
    for(const action of ['active-source',`snapshot&sourceId=${source.sourceId}`,`bootstrap&sourceId=${source.sourceId}`])expect((await context.request.get(`${origin}/api/cloud?action=${action}`)).status()).toBe(401);
    await page.setViewportSize({width:390,height:844});await page.goto(origin);
    expect(await localDatabaseState(page)).toEqual({credentials:0,records:0,workspace:false});
    await expect(page.getByRole('heading',{level:1,name:'Sign in to your POS',exact:true})).toBeVisible();
    await page.getByLabel('Cloud owner email',{exact:true}).fill(email);await page.getByLabel('Cloud owner password',{exact:true}).fill(password);
    let delayed=false,delayCompleted=false;
    await page.route(/\/api\/cloud\?action=bootstrap&/,async route=>{
      if(!delayed){delayed=true;await new Promise(resolve=>setTimeout(resolve,6500));delayCompleted=true;}
      await route.continue();
    });
    await page.getByRole('button',{name:'Open cloud workspace',exact:true}).click();
    await expect(page).toHaveURL(new RegExp(`shared=${source.sourceId}`),{timeout:20000});
    await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible({timeout:25000});
    expect(delayed).toBe(true);expect(delayCompleted).toBe(true);
    expect(await localDatabaseState(page)).toEqual({credentials:0,records:0,workspace:false});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await navigate(page,'Customers & dues');
    const row=page.getByRole('row').filter({hasText:'Restored Loan Customer'});await expect(row).toContainText('0774455667');await expect(row).toContainText('Rs. 1,200.00');
    await navigate(page,'Sales history');await expect(page.getByText(order.number,{exact:true})).toBeVisible();
    const recovered=await context.request.get(`${origin}/api/cloud?action=bootstrap&sourceId=${source.sourceId}&branchId=b1`);expect(recovered.status()).toBe(200);
    const snapshot=await recovered.json() as Snapshot;
    expect(snapshot.orders.find(row=>row.id===order.id)?.payments[0].method).toBe('credit');
    expect(snapshot.customers.find(row=>row.id===customer.id)?.balance).toBe(120000);
    expect(snapshot.inventory.find(row=>row.id==='b1-prepared-m1')?.quantity).toBe(48);
    const after=(await store.get(source.sourceId))!;expect(after.records).toEqual(before.records);expect(after.revision).toBe(before.revision);
    expect(errors).toEqual([]);
  }finally{await context.close();await app.close();}
});
