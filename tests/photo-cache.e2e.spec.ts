import {test,expect,type Page} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import type {AddressInfo} from 'node:net';

test.use({serviceWorkers:'allow'});
test.setTimeout(90000);

async function preparedDevice(page:Page){
  await page.goto('/?local=1');
  await page.getByRole('button',{name:'Set up this device',exact:true}).click();
  const setup=page.getByRole('dialog',{name:'Set up this device',exact:true});
  await setup.getByLabel('Business name',{exact:true}).fill('Photo Cache Hotel');
  await setup.getByLabel('Owner name',{exact:true}).fill('Photo Cache Owner');
  await setup.getByLabel(/^Owner PIN/).fill('98765432');
  await setup.getByLabel('Confirm owner PIN',{exact:true}).fill('98765432');
  await setup.getByRole('checkbox',{name:/^Include sample menu and stock/}).check();
  await setup.getByRole('button',{name:'Create device workspace',exact:true}).click();
  await expect(page.getByRole('button',{name:'Add Chicken rice & curry',exact:true})).toBeVisible();
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await page.reload();
  await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);
}

test('a downloaded external product image opens from the service-worker cache on a fully offline restart',async({page,context})=>{
  const bytes=await readFile('public/images/tea.jpg');
  let requests=0;
  // HTTP loopback is fixture-only; real product-link validation requires HTTPS.
  const imageServer=createServer((_request,response)=>{requests++;response.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store'});response.end(bytes);});
  await new Promise<void>(resolve=>imageServer.listen(0,'127.0.0.1',resolve));
  const externalURL=`http://127.0.0.1:${(imageServer.address() as AddressInfo).port}/product-photo.jpg`;
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await preparedDevice(page);
    const cdp=await context.newCDPSession(page);
    await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
    await page.evaluate(url=>new Promise<void>((resolve,reject)=>{
      const opening=indexedDB.open('demo-hotel-local-workspace-v1');
      opening.onerror=()=>reject(opening.error);
      opening.onsuccess=()=>{
        const db=opening.result,transaction=db.transaction('records','readwrite'),store=transaction.objectStore('records');
        const reading=store.get(['menu','m1']);
        reading.onsuccess=()=>{const row=reading.result;store.put({...row,value:{...row.value,image:url}});};
        transaction.oncomplete=()=>{db.close();resolve();};transaction.onabort=()=>{db.close();reject(transaction.error);};
      };
    }),externalURL);
    await page.reload();
    const photo=page.getByAltText('Chicken rice & curry',{exact:true}).first();
    await expect.poll(()=>photo.evaluate(image=>(image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect.poll(()=>page.evaluate(async url=>Boolean(await (await caches.open('hotel-pos-product-images-v1')).match(url)),externalURL)).toBe(true);
    expect(requests).toBe(1);
    const downloaded=requests;
    await cdp.send('Network.clearBrowserCache');
    await cdp.detach();
    await context.setOffline(true);
    await expect.poll(()=>page.evaluate(()=>navigator.onLine)).toBe(false);
    await page.reload();
    await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();
    await expect.poll(()=>photo.evaluate(image=>(image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await page.evaluate(()=>navigator.onLine)).toBe(false);
    expect(requests).toBe(downloaded);
    expect(errors).toEqual([]);
  }finally{await new Promise<void>((resolve,reject)=>imageServer.close(error=>error?reject(error):resolve()));}
});

test('more than 32 mounted uploaded product photos retain valid local object URLs',async({page,context})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await preparedDevice(page);
  await page.evaluate(()=>new Promise<void>((resolve,reject)=>{
    const canvas=document.createElement('canvas');canvas.width=240;canvas.height=240;
    const drawing=canvas.getContext('2d')!;drawing.fillStyle='#c79d48';drawing.fillRect(0,0,240,240);
    const encoded=canvas.toDataURL('image/jpeg',.8).split(',')[1];
    const opening=indexedDB.open('demo-hotel-local-workspace-v1');
    opening.onerror=()=>reject(opening.error);
    opening.onsuccess=()=>{
      const db=opening.result,transaction=db.transaction('records','readwrite'),store=transaction.objectStore('records');
      const reading=store.get(['menu','m1']);
      reading.onsuccess=()=>{
        const template=reading.result,timestamp=new Date().toISOString();
        for(let i=0;i<40;i++){
          const suffix=String(i).padStart(8,'0'),id=`media-local-${suffix}`,menuId=`local-photo-${suffix}`;
          store.put({kind:'media',id,branchId:null,createdAt:timestamp,updatedAt:timestamp,value:{id,branchId:null,createdAt:timestamp,mime:'image/jpeg',data:encoded,byteLength:atob(encoded).length,width:240,height:240}});
          store.put({...template,id:menuId,value:{...template.value,id:menuId,name:`Local cache photo ${suffix}`,image:`local-image:${id}`,stockMode:'untracked',available:true,enabled:true}});
        }
      };
      transaction.oncomplete=()=>{db.close();resolve();};transaction.onabort=()=>{db.close();reject(transaction.error);};
    };
  }));
  await context.setOffline(true);await page.reload();
  const photos=page.getByRole('img',{name:/^Local cache photo /});
  await expect(photos).toHaveCount(40);
  await expect.poll(()=>photos.evaluateAll(images=>images.length===40&&images.every(image=>image instanceof HTMLImageElement))).toBe(true);
  await photos.evaluateAll(images=>{for(const image of images)if(image instanceof HTMLImageElement)image.loading='eager';});
  await expect.poll(()=>photos.evaluateAll(images=>images.length===40&&images.every(image=>image instanceof HTMLImageElement&&image.naturalWidth===240))).toBe(true);
  expect(errors).toEqual([]);
});
