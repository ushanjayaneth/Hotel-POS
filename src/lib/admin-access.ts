import {useSyncExternalStore} from 'react';
import type {Snapshot} from '../../shared/types';
import {isAdminCommit,type AdminAccessConfiguration as Configuration,type SealedAdminAccess} from '../../shared/admin-access';
interface Access {enabled:boolean;unlocked:boolean}
const configurations=new Map<string,Configuration>();
const grants=new Map<string,string>();
const states=new Map<string,Access>();
const listeners=new Set<()=>void>();
const key='adminAccess:configuration';
const disabled:Access={enabled:false,unlocked:true};
const preference=(sourceId:string)=>`dh-admin-enabled:${sourceId}`;
const browser=()=>typeof document!=='undefined';
const currentSource=()=>typeof location==='undefined'?null:new URLSearchParams(location.search).get('shared');
function savedFlag(sourceId:string){
  try{const value=localStorage.getItem(preference(sourceId))??localStorage.getItem('dh-admin-enabled');return value===null?browser():value==='1';}catch{return browser();}
}
function changed(sourceId:string){
  const enabled=configurations.get(sourceId)?.enabled??savedFlag(sourceId);
  const next={enabled,unlocked:!enabled||grants.has(sourceId)},previous=states.get(sourceId);
  if(previous&&previous.enabled===next.enabled&&previous.unlocked===next.unlocked)return;
  states.set(sourceId,next);for(const listener of listeners)listener();
}
export function adminAccess(sourceId:string|null=currentSource()):Access{
  if(!sourceId)return disabled;
  if(!states.has(sourceId)){
    const enabled=configurations.get(sourceId)?.enabled??savedFlag(sourceId);
    states.set(sourceId,{enabled,unlocked:!enabled||grants.has(sourceId)});
  }
  return states.get(sourceId)!;
}
export function useAdminAccess(sourceId:string|null){
  return useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},()=>adminAccess(sourceId),()=>disabled);
}
function packageValid(value:unknown,sourceId:string):value is SealedAdminAccess{
  const pkg=value as SealedAdminAccess|undefined;
  return pkg?.v===1&&pkg.sourceId===sourceId&&typeof pkg.version==='string'&&/^[a-f0-9]{64}$/.test(pkg.salt)
    &&/^[a-f0-9]{24}$/.test(pkg.iv)&&Number.isInteger(pkg.iterations)&&pkg.iterations>=100000&&pkg.iterations<=2000000
    &&typeof pkg.ciphertext==='string'&&pkg.ciphertext.length<16000&&Number.isFinite(pkg.expiresAt);
}
async function database(sourceId:string){return (await import('./cloud-offline')).getCloudOfflineReplica(sourceId).db;}
export async function configureAdminAccess(sourceId:string,value:Configuration,persist=true){
  const previous=configurations.get(sourceId);
  const next:Configuration={enabled:value.enabled,...(packageValid(value.offline,sourceId)?{offline:value.offline}:previous?.offline?{offline:previous.offline}:{})};
  if(!next.enabled||previous?.offline?.version&&next.offline?.version!==previous.offline.version)grants.delete(sourceId);
  configurations.set(sourceId,next);
  try{localStorage.setItem(preference(sourceId),next.enabled?'1':'0');}catch{/* The private database remains available. */}
  changed(sourceId);
  if(persist&&JSON.stringify(previous)!==JSON.stringify(next))await (await database(sourceId)).metadata.put({key,value:next});
}
export async function hydrateAdminAccess(sourceId:string){
  const value=(await (await database(sourceId)).metadata.get(key))?.value as Configuration|undefined;
  if(value&&typeof value.enabled==='boolean')await configureAdminAccess(sourceId,value,false);
}
/** Configuration contains only a PIN-encrypted capability, never the PIN. */
export async function observeAdminResponse(action:string,result:unknown){
  if(!result||typeof result!=='object')return;
  const data=result as {adminLockEnabled?:boolean;adminAccess?:Configuration;offlineState?:{sourceId:string;metadata?:{adminAccess?:Configuration}}};
  const sourceId=data.offlineState?.sourceId??currentSource()??(()=>{try{return localStorage.getItem('dh-cloud-preferred-source');}catch{return null;}})();
  if(typeof data.adminLockEnabled==='boolean'){
    try{localStorage.setItem('dh-admin-enabled',data.adminLockEnabled?'1':'0');}catch{/* Optional preference storage. */}
    if(sourceId&&/^[A-Za-z0-9_-]{1,160}$/.test(sourceId))await configureAdminAccess(sourceId,{enabled:data.adminLockEnabled});
  }
  const config=data.adminAccess??data.offlineState?.metadata?.adminAccess;
  if(sourceId&&/^[A-Za-z0-9_-]{1,160}$/.test(sourceId)&&config&&typeof config.enabled==='boolean')await configureAdminAccess(sourceId,config);
}
const bytes=(hex:string)=>Uint8Array.from(hex.match(/../g)??[],value=>parseInt(value,16));
function grantExpiry(value:string,sourceId:string){
  try{const payload=JSON.parse(atob(value.split('.')[0].replace(/-/g,'+').replace(/_/g,'/')));return payload.sourceId===sourceId&&typeof payload.exp==='number'?payload.exp:0;}catch{return 0;}
}
export async function unlockAdmin(sourceId:string,pin:string){
  if(!/^\d{4,16}$/.test(pin))throw new Error('Enter the admin PIN.');
  await hydrateAdminAccess(sourceId);
  let config=configurations.get(sourceId),pkg=config?.offline;
  if(!config?.enabled)return;
  if(typeof navigator!=='undefined'&&navigator.onLine!==false){
    try{
      // Refresh approval when reachable so a changed PIN cannot remain usable
      // online. A network outage still permits the prepared offline unlock.
      const response=await fetch('/api/cloud?action=admin-unlock',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceId,pin}),signal:AbortSignal.timeout(2500)});
      const value=await response.json() as {error?:string;adminAccess?:Configuration};
      if(!response.ok)throw Object.assign(new Error(value.error??'Unable to unlock admin access.'),{status:response.status});
      if(value.adminAccess)await configureAdminAccess(sourceId,value.adminAccess);
      config=configurations.get(sourceId);pkg=config?.offline;
    }catch(error){
      const status=(error as {status?:number}).status;
      if(status&&status<500)throw error;
      if(!pkg||pkg.expiresAt<=Date.now())throw new Error('Connect to the internet once to prepare admin access on this device.');
    }
  }
  if(!pkg||pkg.expiresAt<=Date.now())throw new Error('Connect to the internet once to prepare admin access on this device.');
  const db=await database(sourceId),throttleKey='adminAccess:attempts';
  await db.transaction('rw',db.metadata,async()=>{
    const previous=(await db.metadata.get(throttleKey))?.value as {attempts:number;until:number;version:string}|undefined;
    const state=previous?.until&&previous.until>Date.now()&&previous.version===pkg.version?previous:{attempts:0,until:Date.now()+15*60000,version:pkg.version};
    if(state.attempts>=10)throw new Error('Too many incorrect admin PIN attempts. Try again in 15 minutes.');
    await db.metadata.put({key:throttleKey,value:{...state,attempts:state.attempts+1}});
  });
  let grant:string;
  try{
    const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(pin),'PBKDF2',false,['deriveKey']);
    const secret=await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt:bytes(pkg.salt),iterations:pkg.iterations},material,{name:'AES-GCM',length:256},false,['decrypt']);
    const encrypted=Uint8Array.from(atob(pkg.ciphertext),value=>value.charCodeAt(0));
    const decoded=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(pkg.iv),additionalData:new TextEncoder().encode(`hotel-pos-admin:${sourceId}`)},secret,encrypted);
    const value=JSON.parse(new TextDecoder().decode(decoded)) as {grant?:unknown};
    if(typeof value.grant!=='string'||grantExpiry(value.grant,sourceId)<=Date.now())throw new Error('Invalid admin capability.');
    grant=value.grant;
  }catch{throw new Error('The admin PIN is incorrect.');}
  await db.metadata.delete(throttleKey);
  // An explicit unlock also approves retrying saved administrative changes
  // created before this lock was enabled or before its credential was rotated.
  await db.transaction('rw',db.metadata,async()=>{
    const pending=await db.metadata.where('key').startsWith('cloudOffline:outbox:').toArray();
    for(const row of pending){
      const entry=row.value as {commit?:Parameters<typeof isAdminCommit>[0]&{adminGrant?:string}};
      if(entry.commit&&isAdminCommit(entry.commit))await db.metadata.put({...row,value:{...entry,commit:{...entry.commit,adminGrant:grant}}});
    }
  });
  grants.set(sourceId,grant);changed(sourceId);
}
export function lockAdmin(sourceId:string|null=currentSource()){
  if(!sourceId)return;
  const enabled=adminAccess(sourceId).enabled;
  grants.delete(sourceId);changed(sourceId);
  if(enabled&&typeof navigator!=='undefined'&&navigator.onLine!==false)void fetch('/api/cloud?action=admin-lock',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceId}),signal:AbortSignal.timeout(2000)}).catch(()=>{});
}
export function adminGrant(sourceId:string){return adminAccess(sourceId).unlocked?grants.get(sourceId):undefined;}
export function requireAdmin(sourceId:string){
  const access=adminAccess(sourceId);
  if(access.enabled&&!access.unlocked){
    if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('admin-access-required',{detail:{sourceId}}));
    throw Object.assign(new Error('Unlock admin access from the hotel logo to continue.'),{status:403,code:'ADMIN_LOCKED'});
  }
}
export const adminPages=new Set(['overview','products','inventory','production','purchases','reports','team']);
/** Keep cashier context free of cost, profit, supplier and staff information. */
export function cashierSnapshot(data:Snapshot):Snapshot{
  return {...data,user:['owner','manager'].includes(data.user.role)?{...data.user,role:'cashier'}:data.user,
    menu:data.menu.map(item=>({...item,cost:0})),recipes:[],inventory:data.inventory.map(item=>({...item,unitCost:0})),stockMovements:[],production:[],suppliers:[],purchases:[],staff:[],expenses:[],audit:[],
    orders:data.orders.map(order=>({...order,lines:order.lines.map(({unitCost:_unitCost,costBasis:_basis,...line})=>line)})),
  };
}
