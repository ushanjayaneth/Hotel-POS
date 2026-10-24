import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,scryptSync} from 'node:crypto';
import {createMonitorHandler} from '../server/monitor/handler';
import {MemoryMonitorStore} from '../server/monitor/store';

const pin='98765432';
const encoded=(value:string)=>{const salt='ab'.repeat(32);return `scrypt$${salt}$${scryptSync(value,Buffer.from(salt,'hex'),64).toString('hex')}`;};
const env={CLOUD_POS_PIN_HASH:encoded(pin),CLOUD_SESSION_SECRET:'s'.repeat(64)};
function fixture(configuration:NodeJS.ProcessEnv={...env}) {
  const store=new MemoryMonitorStore(),handler=createMonitorHandler({store,env:configuration});
  const client=()=>{
    let cookie='';
    const call=async(action:string,body?:unknown,extra:HeadersInit={})=>{
      const headers=new Headers(extra);headers.set('Origin','https://pos.test');headers.set('Content-Type','application/json');
      if(cookie)headers.set('Cookie',cookie);
      const response=await handler(new Request(`https://pos.test/api/cloud?action=${action}`,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)}));
      if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie')!.split(';')[0];
      return response;
    };
    return {call,getCookie:()=>cookie};
  };
  return {store,handler,client};
}

test('normal POS PIN opens one shared Firebase business on three devices without separate owner accounts',async()=>{
  const f=fixture(),clients=Array.from({length:3},()=>f.client());
  const status=await (await clients[0].call('status')).json();
  assert.deepEqual(status,{configured:true,missing:[],posPinConfigured:true});
  assert.doesNotMatch(JSON.stringify(status),/scrypt|98765432/);
  assert.deepEqual(await (await clients[0].call('pos-session')).json(),{authenticated:false});
  assert.equal((await clients[0].call('workspace',{create:true})).status,401);
  assert.equal((await clients[0].call('enroll',{sourceId:'anonymous'})).status,401);
  for(const client of clients){
    const login=await client.call('pos-login',{pin});assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie')!;
    assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.match(cookie,/; Secure/);
    assert.doesNotMatch(cookie,new RegExp(pin));
    assert.deepEqual(await (await client.call('pos-session')).json(),{authenticated:true});
    assert.deepEqual(await (await client.call('session')).json(),{authenticated:true});
  }
  const opened=await Promise.all(clients.map(client=>client.call('workspace',{create:true}).then(response=>response.json())));
  assert.deepEqual(opened,[{sourceId:'main-store'},{sourceId:'main-store'},{sourceId:'main-store'}]);
  assert.equal((await f.store.list()).length,1);
  for(const client of clients){
    assert.equal((await client.call('bootstrap&sourceId=main-store&branchId=b1')).status,200);
    const signout=await client.call('pos-logout',{});assert.equal(signout.status,200);assert.match(signout.headers.get('set-cookie')!,/Max-Age=0/);
    assert.deepEqual(await (await client.call('pos-session')).json(),{authenticated:false});
    assert.equal((await client.call('snapshot&sourceId=main-store')).status,401);
  }
});

test('POS PIN sign-in permits authenticated original-device enrollment but exposes no PIN or password fields',async()=>{
  const f=fixture(),client=f.client();
  assert.equal((await client.call('pos-login',{pin})).status,200);
  const enrollment=await client.call('enroll',{sourceId:'original-counter',workspaceId:'original-workspace',businessName:'Saved shop',deviceName:'Cashier computer'});
  assert.equal(enrollment.status,200);
  const grant=await enrollment.json();assert.equal(typeof grant.token,'string');
  const upload=await client.call('push',{sourceId:grant.sourceId,epoch:grant.epoch,sequence:1,eventId:'original-device-baseline',ready:true,changes:[{kind:'customer',id:'customer1',branchId:null,value:{id:'customer1',name:'Saved customer',pin:'12345678'}}]},{Authorization:`Bearer ${grant.token}`});
  assert.equal(upload.status,400);assert.equal(Object.keys((await f.store.get(grant.sourceId))!.records).length,0);
  assert.equal((await client.call('login',{email:'unused@test.example',password:'unconfigured-password'})).status,503);
});

test('POS PIN authentication rejects cross-site requests, invalid PINs and brute force independently of legacy login',async()=>{
  const f=fixture({...env,CLOUD_OWNER_EMAIL:'owner@example.test',CLOUD_OWNER_PASSWORD:'legacy-test-password'}),client=f.client();
  const crossSite=await f.handler(new Request('https://pos.test/api/cloud?action=pos-login',{method:'POST',headers:{Origin:'https://evil.test','Content-Type':'application/json'},body:JSON.stringify({pin})}));assert.equal(crossSite.status,403);
  for(const candidate of ['1234','12ab56','',pin+' ',...Array(8).fill('111111')])assert.equal((await client.call('pos-login',{pin:candidate})).status,401);
  assert.equal((await client.call('pos-login',{pin})).status,429);
  assert.equal((await client.call('login',{email:'owner@example.test',password:'legacy-test-password'})).status,200);
  assert.deepEqual(await (await client.call('pos-session')).json(),{authenticated:true});
  assert.equal((await f.client().call('sources')).status,401);
});

test('PIN-only sessions expire, reject tampering and incorrect purposes, and revoke after PIN rotation',async()=>{
  const configuration={...env},f=fixture(configuration),client=f.client();
  await client.call('pos-login',{pin});const cookie=client.getCookie(),token=cookie.slice('hotel-cloud='.length);
  const payload=JSON.parse(Buffer.from(token.split('.')[0],'base64url').toString()) as Record<string,unknown>;
  const signedCookie=(changes:Record<string,unknown>)=>{const text=Buffer.from(JSON.stringify({...payload,...changes})).toString('base64url');return `hotel-cloud=${text}.${createHmac('sha256',configuration.CLOUD_SESSION_SECRET).update(text).digest('base64url')}`;};
  const session=async(value:string)=>await (await f.handler(new Request('https://pos.test/api/cloud?action=pos-session',{headers:{Cookie:value}}))).json();
  assert.deepEqual(await session(cookie),{authenticated:true});
  assert.deepEqual(await session(cookie.slice(0,-1)+'!'),{authenticated:false});
  assert.deepEqual(await session(signedCookie({exp:Date.now()-1})),{authenticated:false});
  assert.deepEqual(await session(signedCookie({purpose:'writer'})),{authenticated:false});
  configuration.CLOUD_POS_PIN_HASH=encoded('87654321');
  assert.deepEqual(await session(cookie),{authenticated:false});
  assert.equal((await client.call('sources')).status,401);
  assert.equal((await client.call('pos-login',{pin})).status,401);
  assert.equal((await client.call('pos-login',{pin:'87654321'})).status,200);
});

test('PIN configuration fails closed for missing or malformed hashes and never enables the four-digit default',async()=>{
  for(const configuration of [
    {CLOUD_SESSION_SECRET:env.CLOUD_SESSION_SECRET},
    {CLOUD_SESSION_SECRET:env.CLOUD_SESSION_SECRET,CLOUD_POS_PIN:'1234'},
    {CLOUD_SESSION_SECRET:env.CLOUD_SESSION_SECRET,CLOUD_POS_PIN_HASH:'scrypt$bad$bad',CLOUD_POS_PIN:pin},
  ]){
    const f=fixture(configuration),client=f.client(),status=await (await client.call('status')).json();
    assert.equal(status.configured,false);assert.equal(status.posPinConfigured,false);
    assert.ok(status.missing.includes('CLOUD_POS_PIN_HASH'));
    assert.equal((await client.call('pos-login',{pin})).status,503);
    assert.equal((await f.store.list()).length,0);
  }
  const raw=fixture({CLOUD_SESSION_SECRET:env.CLOUD_SESSION_SECRET,CLOUD_POS_PIN:pin}).client();assert.equal((await raw.call('pos-login',{pin})).status,200);
  const weakHash=fixture({CLOUD_SESSION_SECRET:env.CLOUD_SESSION_SECRET,CLOUD_POS_PIN_HASH:encoded('1234')}).client();assert.equal((await weakHash.call('pos-login',{pin:'1234'})).status,401);
});

test('authenticated grant refresh resumes the original source after PIN rotation without resetting its epoch, sequence or records',async()=>{
  const configuration={...env},f=fixture(configuration),client=f.client();
  await client.call('pos-login',{pin});
  const enrollment=await (await client.call('enroll',{sourceId:'saved-original-counter',workspaceId:'saved-original-workspace',businessName:'Original shop',deviceName:'Original computer'})).json();
  const packet={sourceId:enrollment.sourceId,epoch:enrollment.epoch,sequence:1,eventId:'original-partial-baseline',ready:false,changes:[{kind:'customer',id:'saved-customer',branchId:null,value:{id:'saved-customer',name:'Existing customer'}}]};
  assert.equal((await client.call('push',packet,{Authorization:`Bearer ${enrollment.token}`})).status,200);
  const before=(await f.store.get(enrollment.sourceId))!;
  const refresh={sourceId:enrollment.sourceId,workspaceId:before.source.workspaceId};
  assert.equal((await f.client().call('refresh-device',refresh)).status,401);
  configuration.CLOUD_POS_PIN_HASH=encoded('87654321');
  assert.equal((await client.call('refresh-device',refresh)).status,401);
  await client.call('pos-login',{pin:'87654321'});
  assert.equal((await client.call('refresh-device',{...refresh,workspaceId:'another-workspace'})).status,403);
  assert.equal((await client.call('refresh-device',{...refresh,sourceId:'unknown-counter'})).status,404);
  assert.equal((await client.call('push',{...packet,sequence:2,eventId:'pending-local-sale'},{Authorization:`Bearer ${enrollment.token}`})).status,401);
  const renewed=await (await client.call('refresh-device',refresh)).json();
  assert.equal(renewed.sourceId,enrollment.sourceId);assert.equal(renewed.epoch,enrollment.epoch);assert.notEqual(renewed.token,enrollment.token);
  assert.deepEqual(await f.store.get(enrollment.sourceId),before);assert.equal((await f.store.list()).length,1);
  assert.equal((await client.call('push',{...packet,sequence:2,eventId:'pending-local-sale'},{Authorization:`Bearer ${renewed.token}`})).status,200);
  assert.equal((await f.store.get(enrollment.sourceId))!.source.sequence,2);
  await client.call('revoke',{sourceId:enrollment.sourceId});
  assert.equal((await client.call('refresh-device',refresh)).status,404);
});

test('grant refresh cannot re-enable independent uploads to an already shared shop',async()=>{
  const f=fixture(),client=f.client();await client.call('pos-login',{pin});
  await client.call('workspace',{create:true});const before=(await f.store.get('main-store'))!;
  const response=await client.call('refresh-device',{sourceId:'main-store',workspaceId:before.source.workspaceId});
  assert.equal(response.status,409);assert.equal((await response.json()).code,'SHARED_WORKSPACE');
  assert.deepEqual(await f.store.get('main-store'),before);
});
