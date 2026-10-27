import {chromium,test,expect,type BrowserContext,type Page,type Request as PlaywrightRequest} from '@playwright/test';
import staticPlugin from '@fastify/static';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {createApp} from '../server/app';
import {MemoryMonitorStore} from '../server/monitor/store';

test.setTimeout(150_000);
test.use({actionTimeout:15000});
const pin='84172693';
const profilePrefix='hotel-pos-remember-browser-';

async function expectPOS(page:Page){
  await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();
  await expect(page.getByRole('button',{name:'Add Chicken rice & curry',exact:true})).toBeVisible();
  await expect(page.getByLabel('Staff PIN',{exact:true})).toHaveCount(0);
}

async function signIn(page:Page){
  await page.getByLabel('Staff PIN',{exact:true}).fill(pin);
  await page.getByRole('button',{name:'Open workspace',exact:true}).click();
  await expectPOS(page);
}

async function openShop(){
  // Every server, cloud store and browser profile belongs only to this test.
  const directory=resolve(await mkdtemp(join(tmpdir(),profilePrefix)));
  const store=new MemoryMonitorStore(),errors:string[]=[];
  const app=await createApp({databasePath:':memory:',seed:true,monitor:{store,env:{CLOUD_POS_PIN:pin,CLOUD_SESSION_SECRET:randomBytes(48).toString('hex')}}});
  let context:BrowserContext|undefined,logins=0;
  app.addHook('onRequest',async request=>{
    if(new URL(request.url,'http://fixture').searchParams.get('action')==='pos-login')logins++;
  });
  await app.register(staticPlugin,{root:resolve('dist'),wildcard:false});
  const origin=await app.listen({host:'127.0.0.1',port:0});
  const open=async({offline=false,profile='trusted'}:{offline?:boolean;profile?:'trusted'|'empty'}={})=>{
    // Closing a persistent context exits its whole Chromium process. Reopening
    // the same directory exercises on-disk cookies, IndexedDB and PWA caches.
    await context?.close();
    context=await chromium.launchPersistentContext(join(directory,profile),{
      headless:true,channel:process.env.PLAYWRIGHT_CHANNEL,viewport:{width:1440,height:1000},
      serviceWorkers:'allow',timezoneId:'Asia/Colombo',offline,
    });
    const watch=(page:Page)=>page.on('pageerror',error=>errors.push(error.message));
    context.on('page',watch);
    for(const page of context.pages())watch(page);
    const page=context.pages()[0]??await context.newPage();
    return {context,page};
  };
  const close=async()=>{
    await context?.close();
    await app.close();
    // Delete only the exact temporary profile root created above.
    if(dirname(directory)!==resolve(tmpdir())||!basename(directory).startsWith(profilePrefix))throw new Error('Unexpected browser profile cleanup path.');
    await rm(directory,{recursive:true,force:true});
  };
  const setup=async()=>{
    const {context,page}=await open();
    await page.goto(`${origin}/?local=1`);
    await page.getByRole('button',{name:'Set up this device',exact:true}).click();
    const setup=page.getByRole('dialog',{name:'Set up this device',exact:true});
    await setup.getByLabel('Business name',{exact:true}).fill('Remembered Login Test Hotel');
    await setup.getByLabel('Owner name',{exact:true}).fill('Remembered Login Test Owner');
    await setup.getByLabel(/^Owner PIN/).fill(pin);
    await setup.getByLabel('Confirm owner PIN',{exact:true}).fill(pin);
    await setup.getByRole('checkbox',{name:/^Include sample menu/}).check();
    await setup.getByRole('button',{name:'Create device workspace',exact:true}).click();
    await expect(page.getByRole('button',{name:'Add Chicken rice & curry',exact:true})).toBeVisible();
    await page.goto(origin);await signIn(page);
    await expect(page).toHaveURL(/shared=/);
    await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
    await page.reload();await expectPOS(page);
    await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);
    expect(logins).toBe(1);
    expect((await store.list()).filter(source=>source.ready&&source.shared)).toHaveLength(1);
    return {context,page};
  };
  return {origin,store,errors,open,close,setup,logins:()=>logins};
}

test('one verified PIN survives whole-browser closes and online and offline reopen of the same profile',async()=>{
  const shop=await openShop();
  try{
    let {context,page}=await shop.setup();
    const cookie=(await context.cookies(shop.origin)).find(cookie=>cookie.name==='hotel-cloud');
    expect(cookie).toBeDefined();expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.expires).toBeGreaterThan(Date.now()/1000+360*86400);

    ({context,page}=await shop.open());
    await page.goto(shop.origin);await expectPOS(page);
    expect((await context.cookies(shop.origin)).some(cookie=>cookie.name==='hotel-cloud')).toBe(true);
    expect(shop.logins()).toBe(1);

    // Reopen with the browser network disabled from launch, before navigation.
    ({context,page}=await shop.open({offline:true}));
    await page.goto(shop.origin,{waitUntil:'domcontentloaded'});await expectPOS(page);
    expect(await page.evaluate(()=>navigator.onLine)).toBe(false);
    await expect(page.locator('.notice-banner')).toContainText('Working offline');
    expect(shop.logins()).toBe(1);

    ({context,page}=await shop.open());
    await page.goto(shop.origin);await expectPOS(page);
    expect(shop.logins()).toBe(1);expect(shop.errors).toEqual([]);
  }finally{await shop.close();}
});

test('explicit Sign out remains locked after whole-browser reopen online and offline',async()=>{
  const shop=await openShop();
  try{
    let {context,page}=await shop.setup();
    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    await expect(page.getByLabel('Staff PIN',{exact:true})).toBeVisible();
    expect((await context.cookies(shop.origin)).some(cookie=>cookie.name==='hotel-cloud')).toBe(false);

    ({context,page}=await shop.open());
    await page.goto(shop.origin);
    await expect(page.getByLabel('Staff PIN',{exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toHaveCount(0);
    expect((await context.cookies(shop.origin)).some(cookie=>cookie.name==='hotel-cloud')).toBe(false);

    ({page}=await shop.open({offline:true}));
    await page.goto(shop.origin,{waitUntil:'domcontentloaded'});
    await expect(page.getByLabel('Staff PIN',{exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toHaveCount(0);
    expect(shop.logins()).toBe(1);expect(shop.errors).toEqual([]);
  }finally{await shop.close();}
});

test('Sign out cancels a pending refresh before its late response can restore the login cookie',async()=>{
  const shop=await openShop();
  let release=()=>{};
  try{
    const {context,page}=await shop.setup();
    const cookie=(await context.cookies(shop.origin)).find(cookie=>cookie.name==='hotel-cloud')!;
    expect(cookie).toBeDefined();
    const lateCookie=`hotel-cloud=${cookie.value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000; Expires=${new Date(Date.now()+365*86400000).toUTCString()}`;
    let captured=false,held=false,requestFailed=false,fulfillAttempted=false;
    let heldRequest:PlaywrightRequest|undefined;
    const gate=new Promise<void>(accept=>{release=accept;});
    let finished=()=>{};
    const completed=new Promise<void>(accept=>{finished=accept;});
    page.on('requestfailed',request=>{if(request===heldRequest)requestFailed=true;});
    await page.route(/\/api\/cloud\?action=bootstrap(?:&|$)/,async route=>{
      if(captured){await route.continue();return;}
      captured=true;heldRequest=route.request();
      try{
        const response=await route.fetch(),body=await response.body();
        // route.fetch shares the browser cookie jar, so add the renewal only
        // when delivering the delayed response after Sign out has completed.
        expect(response.headers()['set-cookie']).toBeUndefined();
        held=true;
        await gate;
        fulfillAttempted=true;
        await route.fulfill({status:response.status(),headers:{...response.headers(),'set-cookie':lateCookie},body}).catch(()=>{});
      }finally{finished();}
    });
    await page.getByRole('button',{name:'Refresh workspace',exact:true}).click();
    await expect.poll(()=>held).toBe(true);
    expect(requestFailed).toBe(false);
    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    await expect(page.getByLabel('Staff PIN',{exact:true})).toBeVisible();
    await expect.poll(()=>requestFailed).toBe(true);
    expect((await context.cookies(shop.origin)).some(cookie=>cookie.name==='hotel-cloud')).toBe(false);
    release();await completed;
    expect(fulfillAttempted).toBe(true);
    expect((await context.cookies(shop.origin)).some(cookie=>cookie.name==='hotel-cloud')).toBe(false);
    await page.reload();
    await expect(page.getByLabel('Staff PIN',{exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toHaveCount(0);
    expect((await context.cookies(shop.origin)).some(cookie=>cookie.name==='hotel-cloud')).toBe(false);
    expect(shop.logins()).toBe(1);expect(shop.errors).toEqual([]);
  }finally{release();await shop.close();}
});

test('clearing site data and using a new browser profile each require a staff PIN',async()=>{
  const shop=await openShop();
  try{
    let {context,page}=await shop.setup();
    // Leave the app before clearing storage so background activity cannot
    // repopulate its cookies or IndexedDB while Chrome removes the site data.
    await page.goto('about:blank');
    const session=await context.newCDPSession(page);
    await session.send('Storage.clearDataForOrigin',{origin:shop.origin,storageTypes:'all'});
    await session.detach();
    expect((await context.cookies(shop.origin)).some(cookie=>cookie.name==='hotel-cloud')).toBe(false);

    ({page}=await shop.open());
    await page.goto(shop.origin);
    await expect(page.getByLabel('Staff PIN',{exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toHaveCount(0);

    ({context,page}=await shop.open({profile:'empty'}));
    await page.goto(shop.origin);
    await expect(page.getByLabel('Staff PIN',{exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toHaveCount(0);
    expect((await context.cookies(shop.origin)).some(cookie=>cookie.name==='hotel-cloud')).toBe(false);
    expect(shop.logins()).toBe(1);expect(shop.errors).toEqual([]);
  }finally{await shop.close();}
});
