import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDecipheriv,createHmac,pbkdf2Sync,randomUUID,scryptSync} from 'node:crypto';
import {createAdminAccess} from '../server/monitor/admin-access';
import {createMonitorHandler} from '../server/monitor/handler';
import {monitorCommand} from '../server/monitor/engine';
import {MemoryMonitorStore,recordKey,type Projection} from '../server/monitor/store';
import type {SealedAdminAccess} from '../shared/admin-access';
import type {CloudChange} from '../shared/cloud-monitor';
import type {OfflineCloudCommit} from '../shared/offline-cloud';

const settings={businessName:'Admin Test',tagline:'',currency:'LKR',taxRate:0,serviceChargeRate:0,receiptFooter:'',lowStockAlerts:true,autoPrint:false,language:'en',receiptPaperWidthMm:80,receiptContentWidthMm:72,receiptMarginMm:2,receiptOffsetMm:0,receiptFontSize:10};
const configuration=():NodeJS.ProcessEnv=>({CLOUD_POS_PIN:'98765432',CLOUD_ADMIN_PIN:'0001',CLOUD_SESSION_SECRET:'s'.repeat(64)});

function decrypt(offline:SealedAdminAccess,pin='0001',sourceId=offline.sourceId):string {
  const bytes=Buffer.from(offline.ciphertext,'base64');
  const key=pbkdf2Sync(pin,Buffer.from(offline.salt,'hex'),offline.iterations,32,'sha256');
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(offline.iv,'hex'));
  decipher.setAAD(Buffer.from(`hotel-pos-admin:${sourceId}`));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0,-16)),decipher.final()]).toString()).grant;
}

function baseline():Projection {
  const timestamp=new Date().toISOString();
  const rows:CloudChange[]=[
    {kind:'branch',id:'b1',branchId:null,value:{id:'b1',name:'Test',nameSi:'Test',code:'TEST',address:'',phone:''}},
    {kind:'settings',id:'settings',branchId:null,value:{...settings}},
    {kind:'category',id:'food',branchId:null,value:{id:'food',name:'Food',nameSi:'Food',icon:'grid'}},
    {kind:'menu',id:'rice',branchId:null,value:{id:'rice',name:'Rice',nameSi:'Rice',description:'',categoryId:'food',price:10000,cost:4000,image:'/images/curry.jpg',available:true,stockMode:'prepared',preparationMinutes:1}},
    {kind:'inventory',id:'stock-rice',branchId:'b1',value:{id:'stock-rice',branchId:'b1',name:'Rice',nameSi:'Rice',category:'prepared',unit:'portions',quantity:3,minimum:1,unitCost:4000,supplierId:null,menuItemId:'rice',updatedAt:timestamp}},
    {kind:'shift',id:'shift',branchId:'b1',value:{id:'shift',branchId:'b1',openedBy:'cloud-owner',openedAt:timestamp,openingFloat:100000,status:'open',closedAt:null,countedCash:null,expectedCash:100000,variance:null}},
  ];
  return {revision:1,source:{sourceId:'shop',workspaceId:'business',businessName:settings.businessName,deviceName:'Shared',epoch:'epoch',sequence:0,ready:true,shared:true,revoked:false,updatedAt:timestamp,lastSeenAt:timestamp,dataVersion:1},records:Object.fromEntries(rows.map(row=>[recordKey(row.kind,row.id),row])),metadata:{settings:{...settings},activeBranchId:'b1',deviceId:'cloud'},commands:{}};
}

async function fixture(env=configuration()) {
  const store=new MemoryMonitorStore();await store.replace('shop',null,baseline());
  const handler=createMonitorHandler({store,env});let cookie='';
  const call=async(action:string,body?:unknown,extra:HeadersInit={},authenticated=true)=>{
    const headers=new Headers(extra);headers.set('Origin','https://shop.test');headers.set('Content-Type','application/json');
    if(authenticated&&cookie)headers.set('Cookie',cookie);
    return handler(new Request(`https://shop.test/api/cloud?action=${action}`,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)}));
  };
  const login=await call('pos-login',{pin:env.CLOUD_POS_PIN});assert.equal(login.status,200);cookie=login.headers.get('set-cookie')!.split(';')[0];
  const command=(path:string,method='GET',body?:Record<string,unknown>,adminGrant?:string)=>call('command',{sourceId:'shop',path,method,...(body?{body}:{}),...(adminGrant?{adminGrant}:{})});
  const unlock=async()=>{
    const response=await call('admin-unlock',{sourceId:'shop',pin:'0001'});assert.equal(response.status,200);
    const data=await response.json();assert.equal(data.unlocked,true);
    assert.equal(data.grant,undefined);return decrypt(data.adminAccess.offline);
  };
  return {store,call,command,unlock,current:async()=>(await store.get('shop'))!};
}

test('0001 encrypts a reusable offline approval with PBKDF2 and authenticated AES-GCM bound to the shop',()=>{
  const admin=createAdminAccess(configuration()),config=admin.configuration('shop');
  assert.equal(config.enabled,true);assert.ok(config.offline);
  const offline=config.offline!;assert.equal(offline.v,1);assert.equal(offline.iterations,600000);
  assert.equal(Buffer.from(offline.salt,'hex').length,32);assert.equal(Buffer.from(offline.iv,'hex').length,12);
  assert.ok(offline.expiresAt>Date.now()+300*86400000);
  const grant=decrypt(offline);assert.equal(admin.validGrant(grant,'shop'),true);
  assert.equal(admin.configuration('shop').offline,offline);
  assert.throws(()=>decrypt(offline,'0002'));assert.throws(()=>decrypt(offline,'0001','other-shop'));
  const changed=Buffer.from(offline.ciphertext,'base64');changed[0]^=1;
  assert.throws(()=>decrypt({...offline,ciphertext:changed.toString('base64')}));
  assert.equal(admin.validGrant(grant,'other-shop'),false);assert.equal(admin.validGrant(grant+'!','shop'),false);
  assert.equal(admin.validGrant(grant+'.extra','shop'),false);assert.equal(admin.validGrant(null,'shop'),false);
});

test('offline approvals reject expired or wrong-purpose signed payloads and are revoked by admin PIN rotation',()=>{
  const env=configuration(),admin=createAdminAccess(env),offline=admin.configuration('shop').offline!,grant=decrypt(offline);
  const payload=JSON.parse(Buffer.from(grant.split('.')[0],'base64url').toString());
  const signed=(changes:Record<string,unknown>)=>{
    const text=Buffer.from(JSON.stringify({...payload,...changes})).toString('base64url');
    return `${text}.${createHmac('sha256',env.CLOUD_SESSION_SECRET!).update(`admin:${text}`).digest('base64url')}`;
  };
  for(const invalid of [signed({exp:Date.now()-1}),signed({purpose:'owner'}),signed({version:'stale'}),signed({exp:'forever'})])assert.equal(admin.validGrant(invalid,'shop'),false);
  env.CLOUD_ADMIN_PIN='0002';assert.equal(admin.validGrant(grant,'shop'),false);assert.equal(admin.validPIN('0001'),false);
  const rotated=admin.configuration('shop').offline!;assert.notEqual(rotated.version,offline.version);
  assert.throws(()=>decrypt(rotated,'0001'));assert.equal(admin.validGrant(decrypt(rotated,'0002'),'shop'),true);
});

test('hashed admin PINs unlock sealed offline access only after correct verification and malformed hashes fail closed',()=>{
  const env=configuration(),salt='ab'.repeat(32);
  env.CLOUD_ADMIN_PIN_HASH=`scrypt$${salt}$${scryptSync('0001',Buffer.from(salt,'hex'),64).toString('hex')}`;delete env.CLOUD_ADMIN_PIN;
  const admin=createAdminAccess(env);assert.deepEqual(admin.configuration('shop'),{enabled:true});
  assert.equal(admin.validPIN('0001'),true);assert.equal(admin.validPIN('1'),false);assert.equal(admin.validPIN('0001 '),false);
  assert.equal(admin.configuration('shop','0002').offline,undefined);
  const offline=admin.configuration('shop','0001').offline!;assert.equal(admin.validGrant(decrypt(offline),'shop'),true);
  env.CLOUD_ADMIN_PIN_HASH='scrypt$invalid';env.CLOUD_ADMIN_PIN='0001';assert.equal(admin.validPIN('0001'),false);
});

test('locked cashier sessions hide costs and block reports, management, price, stock and photo changes',async()=>{
  const f=await fixture(),before=await f.current();
  assert.equal((await f.call('admin-unlock',{sourceId:'shop',pin:'0001'},{},false)).status,401);
  const status=await (await f.call('pos-session')).json();assert.deepEqual(status,{authenticated:true,adminLockEnabled:true});
  const boot=await (await f.call('bootstrap&sourceId=shop&branchId=b1')).json();
  assert.equal(boot.menu[0].cost,0);assert.equal(boot.inventory[0].unitCost,0);
  for(const key of ['recipes','stockMovements','production','suppliers','purchases','staff','expenses','audit'])assert.deepEqual(boot[key],[]);
  assert.equal(boot.adminAccess.enabled,true);assert.ok(boot.adminAccess.offline);
  const blocked=[
    await f.call('snapshot&sourceId=shop'),
    await f.command('/reports/income-expenses?branchId=b1&from=2026-01-01&to=2026-12-31&format=json'),
    await f.command('/inventory?branchId=b1'),
    await f.command('/cashier/../reports/income-expenses?branchId=b1'),
    await f.command('/menu/rice','PATCH',{commandId:randomUUID(),price:12000,image:'/images/new-photo.jpg'}),
    await f.command('/inventory/stock-rice','PATCH',{commandId:randomUUID(),branchId:'b1',quantity:5,expectedQuantity:3}),
    await f.command('/media','POST',{commandId:randomUUID()}),
    await f.command('/settings','PUT',{commandId:randomUUID(),businessName:'Changed'}),
  ];
  for(const response of blocked){assert.equal(response.status,403);assert.equal((await response.json()).code,'ADMIN_LOCKED');}
  assert.deepEqual(await f.current(),before);
  const saleBody={commandId:randomUUID(),branchId:'b1',type:'takeaway',lines:[{menuItemId:'rice',quantity:1}]};
  const sale=await f.command('/orders','POST',saleBody);assert.equal(sale.status,200);
  const result=await sale.json();assert.equal('unitCost' in result.order.lines[0],false);assert.equal('costBasis' in result.order.lines[0],false);
  const replay=await f.command('/orders','POST',saleBody);assert.deepEqual(await replay.json(),result);
  assert.equal((await f.current()).records[recordKey('inventory','stock-rice')].value.quantity,2);
});

test('logo PIN approval restores financial detail and permits stock, price and photo edits, then rotation relocks it',async()=>{
  const env=configuration(),f=await fixture(env),grant=await f.unlock();
  const session=await f.call('admin-session&sourceId=shop',undefined,{'x-pos-admin-grant':grant});assert.equal((await session.json()).unlocked,true);
  const boot=await (await f.call('bootstrap&sourceId=shop&branchId=b1',undefined,{'x-pos-admin-grant':grant})).json();
  assert.equal(boot.menu[0].cost,4000);assert.equal(boot.inventory[0].unitCost,4000);
  assert.equal((await f.command('/reports/income-expenses?branchId=b1&from=2026-01-01&to=2026-12-31&format=json','GET',undefined,grant)).status,200);
  assert.equal((await f.command('/menu/rice','PATCH',{commandId:randomUUID(),price:12000,image:'/images/new-photo.jpg'},grant)).status,200);
  assert.equal((await f.command('/inventory/stock-rice','PATCH',{commandId:randomUUID(),branchId:'b1',quantity:8,expectedQuantity:3,reason:'Physical stock count'},grant)).status,200);
  const current=await f.current();assert.equal(current.records[recordKey('menu','rice')].value.price,12000);assert.equal(current.records[recordKey('menu','rice')].value.image,'/images/new-photo.jpg');assert.equal(current.records[recordKey('inventory','stock-rice')].value.quantity,8);
  env.CLOUD_ADMIN_PIN='0002';
  assert.equal((await f.command('/reports/income-expenses','GET',undefined,grant)).status,403);
  assert.equal((await f.call('pos-session')).status,200);assert.equal((await (await f.call('pos-session')).json()).authenticated,true);
});

test('incorrect admin attempts are rate limited independently and do not lock out cashier sales',async()=>{
  const f=await fixture();
  for(let i=0;i<10;i++){const response=await f.call('admin-unlock',{sourceId:'shop',pin:'9999'});assert.equal(response.status,403);assert.equal((await response.json()).code,'INVALID_ADMIN_PIN');}
  assert.equal((await f.call('admin-unlock',{sourceId:'shop',pin:'0001'})).status,429);
  assert.equal((await (await f.call('pos-session')).json()).authenticated,true);
  const sale=await f.command('/orders','POST',{commandId:randomUUID(),branchId:'b1',type:'takeaway',lines:[{menuItemId:'rice',quantity:1}]});assert.equal(sale.status,200);
});

test('offline product updates require approval including disguised effects and remain idempotent across renewed grants',async()=>{
  const f=await fixture(),before=await f.current(),local=structuredClone(before),transactionId=randomUUID();
  await monitorCommand(local,'/menu/rice','PATCH',{commandId:transactionId,price:14000,image:'/images/new-photo.jpg'},new URLSearchParams());
  const changes=[...new Set([...Object.keys(local.records),...Object.keys(before.records)])].filter(key=>JSON.stringify(local.records[key])!==JSON.stringify(before.records[key])).map(key=>{
    const row=local.records[key]??before.records[key];return {kind:row.kind,id:row.id,branchId:row.branchId,before:before.records[key]?.value??null,after:local.records[key]?.value??null};
  });
  const packet:OfflineCloudCommit={sourceId:'shop',deviceId:'offline-admin',transactionId,createdAt:new Date().toISOString(),path:'/menu/rice',method:'PATCH',offline:true,changes};
  assert.equal((await f.call('offline-commit',packet)).status,403);
  assert.equal((await f.call('offline-commit',{...packet,path:'/orders',method:'POST'})).status,403);
  assert.deepEqual(await f.current(),before);
  const grant=await f.unlock(),response=await f.call('offline-commit',{...packet,adminGrant:grant});assert.equal(response.status,200);
  const result=await response.json(),after=await f.current();assert.equal(after.records[recordKey('menu','rice')].value.price,14000);
  const renewed=decrypt(createAdminAccess(configuration()).configuration('shop').offline!);assert.notEqual(renewed,grant);
  const replay=await f.call('offline-commit',{...packet,adminGrant:renewed,offline:false});assert.equal(replay.status,200);assert.deepEqual(await replay.json(),result);assert.deepEqual(await f.current(),after);
});
