import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createMonitorHandler} from '../server/monitor/handler';
import {MemoryMonitorStore} from '../server/monitor/store';

const pin='98765432',day=86400000,lifetime=365*day;
const defaults={CLOUD_POS_PIN:pin,CLOUD_SESSION_SECRET:'remember-pos-test-secret-'.repeat(3)};
const cookieValue=(response:Response)=>response.headers.get('set-cookie')?.split(';')[0]??'';
const payload=(cookie:string)=>JSON.parse(Buffer.from(cookie.slice('hotel-cloud='.length).split('.')[0],'base64url').toString()) as Record<string,unknown>;
function fixture(configuration:NodeJS.ProcessEnv={...defaults},origin='https://pos.test') {
  const store=new MemoryMonitorStore(),handler=createMonitorHandler({store,env:configuration});
  const call=(action:string,body?:unknown,cookie='')=>handler(new Request(`${origin}/api/cloud?action=${action}`,{
    method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},
    body:body===undefined?undefined:JSON.stringify(body),
  }));
  return {store,handler,call};
}

test('POS login persists privately without rewriting fresh cookies, and cleared browsers still require a PIN',async t=>{
  let time=Date.UTC(2026,9,27);t.mock.method(Date,'now',()=>time);
  const f=fixture(),response=await f.call('pos-login',{pin});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});
  const header=response.headers.get('set-cookie')!,cookie=cookieValue(response),token=payload(cookie);
  assert.match(header,/; HttpOnly(?:;|$)/);assert.match(header,/; SameSite=Strict(?:;|$)/);
  assert.match(header,/; Path=\/(?:;|$)/);assert.match(header,/; Secure(?:;|$)/);
  assert.match(header,/; Max-Age=31536000(?:;|$)/);
  assert.ok(header.includes(`; Expires=${new Date(time+lifetime).toUTCString()}`));
  assert.equal(token.purpose,'pos-owner-v1');assert.equal(token.exp,time+lifetime);
  assert.deepEqual(Object.keys(token).sort(),['exp','purpose','version']);
  assert.doesNotMatch(`${header} ${JSON.stringify(token)}`,/98765432|remember-pos-test-secret|scrypt|"pin"|"password"/);
  time+=5000;
  for(const action of ['pos-session','session','sources']){
    const response=await f.call(action,undefined,cookie);assert.equal(response.status,200);
    if(action!=='sources')assert.deepEqual(await response.json(),{authenticated:true});
    assert.equal(response.headers.get('set-cookie'),null);
  }
  assert.deepEqual(await (await f.call('pos-session')).json(),{authenticated:false});
  assert.equal((await f.call('sources')).status,401);
  const local=fixture({...defaults},'http://localhost'),http=await local.call('pos-login',{pin});
  assert.equal(http.status,200);assert.doesNotMatch(http.headers.get('set-cookie')!,/; Secure(?:;|$)/);
});

test('POS access survives long browser inactivity and server restarts, then slides with verified activity',async t=>{
  let time=Date.UTC(2026,9,27);t.mock.method(Date,'now',()=>time);
  const f=fixture(),initial=await f.call('pos-login',{pin}),originalCookie=cookieValue(initial),originalExpiry=payload(originalCookie).exp as number;
  time+=90*day;
  const oldActivity=await f.call('sources',undefined,originalCookie);
  assert.equal(oldActivity.status,200);assert.equal(payload(cookieValue(oldActivity)).exp,time+lifetime);
  // A restarted server uses the signed browser cookie without another PIN.
  const restarted=createMonitorHandler({store:f.store,env:{...defaults}});
  const resumed=await restarted(new Request('https://pos.test/api/cloud?action=pos-session',{headers:{Cookie:originalCookie}}));
  assert.deepEqual(await resumed.json(),{authenticated:true});
  const resumedCookie=cookieValue(resumed);assert.equal(payload(resumedCookie).exp,time+lifetime);
  assert.notEqual(resumedCookie,originalCookie);
  time=originalExpiry-day;
  const activity=await f.call('sources',undefined,resumedCookie);
  assert.equal(activity.status,200);assert.equal(payload(cookieValue(activity)).exp,time+lifetime);
  const activeCookie=cookieValue(activity);
  time=originalExpiry+day;
  assert.deepEqual(await (await f.call('pos-session',undefined,activeCookie)).json(),{authenticated:true});
  const expired=await f.call('pos-session',undefined,originalCookie);
  assert.deepEqual(await expired.json(),{authenticated:false});assert.equal(expired.headers.get('set-cookie'),null);
  assert.equal((await f.call('sources',undefined,originalCookie)).status,401);
});

test('POS cookies renew at the daily boundary and still-valid twelve-hour cookies upgrade',async t=>{
  let time=Date.UTC(2026,9,27);t.mock.method(Date,'now',()=>time);
  const f=fixture(),cookie=cookieValue(await f.call('pos-login',{pin}));
  time+=day-1;
  assert.equal((await f.call('sources',undefined,cookie)).headers.get('set-cookie'),null);
  time++;
  const renewed=await f.call('sources',undefined,cookie);
  assert.equal(renewed.status,200);assert.equal(payload(cookieValue(renewed)).exp,time+lifetime);
  const text=Buffer.from(JSON.stringify({...payload(cookie),exp:time+12*3600000})).toString('base64url');
  const legacyCookie=`hotel-cloud=${text}.${createHmac('sha256',defaults.CLOUD_SESSION_SECRET).update(text).digest('base64url')}`;
  const upgraded=await f.call('pos-session',undefined,legacyCookie);
  assert.deepEqual(await upgraded.json(),{authenticated:true});assert.equal(payload(cookieValue(upgraded)).exp,time+lifetime);
});

test('sliding renewal never accepts an expired, forged, malformed or wrong-purpose POS token',async t=>{
  const time=Date.UTC(2026,9,27);t.mock.method(Date,'now',()=>time);
  const f=fixture(),cookie=cookieValue(await f.call('pos-login',{pin})),original=payload(cookie);
  const signed=(changes:Record<string,unknown>)=>{
    const text=Buffer.from(JSON.stringify({...original,...changes})).toString('base64url');
    return `hotel-cloud=${text}.${createHmac('sha256',defaults.CLOUD_SESSION_SECRET).update(text).digest('base64url')}`;
  };
  for(const invalid of [
    cookie.slice(0,-1)+'!',signed({exp:time}),signed({exp:time-1}),signed({exp:undefined}),signed({exp:String(time+lifetime)}),
    signed({purpose:'owner-paired-writer-v3'}),signed({version:'previous-pin-version'}),`${cookie}.extra`,
  ]){
    const session=await f.call('pos-session',undefined,invalid);
    assert.deepEqual(await session.json(),{authenticated:false});assert.equal(session.headers.get('set-cookie'),null);
    const protectedResponse=await f.call('sources',undefined,invalid);
    assert.equal(protectedResponse.status,401);assert.equal(protectedResponse.headers.get('set-cookie'),null);
  }
});

test('PIN rotation revokes remembered access, and both sign-out routes delete the browser cookie',async t=>{
  const time=Date.UTC(2026,9,27);t.mock.method(Date,'now',()=>time);
  const configuration={...defaults},f=fixture(configuration),oldCookie=cookieValue(await f.call('pos-login',{pin}));
  configuration.CLOUD_POS_PIN='87654321';
  const revoked=await f.call('pos-session',undefined,oldCookie);
  assert.deepEqual(await revoked.json(),{authenticated:false});assert.equal(revoked.headers.get('set-cookie'),null);
  assert.equal((await f.call('sources',undefined,oldCookie)).status,401);
  assert.equal((await f.call('pos-login',{pin})).status,401);
  for(const action of ['pos-logout','logout']){
    const login=await f.call('pos-login',{pin:configuration.CLOUD_POS_PIN}),cookie=cookieValue(login);
    assert.equal(login.status,200);assert.notEqual(payload(cookie).version,payload(oldCookie).version);
    const logout=await f.call(action,{},cookie),header=logout.headers.get('set-cookie')!;
    assert.equal(logout.status,200);assert.match(header,/^hotel-cloud=;/);assert.match(header,/; Max-Age=0(?:;|$)/);
    assert.match(header,/; Expires=Thu, 01 Jan 1970 00:00:00 GMT(?:;|$)/);
    assert.match(header,/; HttpOnly(?:;|$)/);assert.match(header,/; SameSite=Strict(?:;|$)/);assert.match(header,/; Secure(?:;|$)/);
    const clearedCookie=cookieValue(logout),session=await f.call('pos-session',undefined,clearedCookie);
    assert.deepEqual(await session.json(),{authenticated:false});assert.equal(session.headers.get('set-cookie'),null);
    assert.equal((await f.call('sources',undefined,clearedCookie)).status,401);
  }
});

test('legacy email owner login keeps its original twelve-hour expiry without sliding renewal',async t=>{
  let time=Date.UTC(2026,9,27);t.mock.method(Date,'now',()=>time);
  const configuration={...defaults,CLOUD_OWNER_EMAIL:'owner@example.test',CLOUD_OWNER_PASSWORD:'legacy-owner-password'};
  const f=fixture(configuration),login=await f.call('login',{email:configuration.CLOUD_OWNER_EMAIL,password:configuration.CLOUD_OWNER_PASSWORD});
  assert.equal(login.status,200);assert.match(login.headers.get('set-cookie')!,/; Max-Age=43200(?:;|$)/);
  const cookie=cookieValue(login),expiry=payload(cookie).exp as number;
  assert.equal(payload(cookie).purpose,'owner');assert.equal(expiry,time+12*3600000);
  time+=6*3600000;
  for(const action of ['session','pos-session','sources']){
    const response=await f.call(action,undefined,cookie);assert.equal(response.status,200);
    assert.equal(response.headers.get('set-cookie'),null);
  }
  time=expiry;
  const session=await f.call('pos-session',undefined,cookie);
  assert.deepEqual(await session.json(),{authenticated:false});assert.equal(session.headers.get('set-cookie'),null);
  assert.equal((await f.call('sources',undefined,cookie)).status,401);
});
