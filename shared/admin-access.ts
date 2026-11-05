import type {Snapshot} from './types.js';

export interface SealedAdminAccess {
  v:1;sourceId:string;version:string;salt:string;iv:string;iterations:number;ciphertext:string;expiresAt:number;
}
export interface AdminAccessConfiguration {enabled:boolean;offline?:SealedAdminAccess}

/** Administrative approval is separate from the ordinary cashier sign-in. */
export function isAdminOperation(inputPath:string,inputMethod='GET',body?:unknown):boolean {
  const path=(new URL(inputPath,'https://workspace').pathname.replace(/^\/api(?=\/)/,'').replace(/\/$/,'')||'/');
  const method=inputMethod.toUpperCase();
  if(method==='GET')return /^\/(?:reports|menu|inventory|production|purchases|suppliers|recipes|staff|audit|backups)(?:\/|$)/.test(path);
  if(/^\/(?:menu|categories|inventory|recipes|production|purchases|suppliers|settings|staff|expenses|media|backups)(?:\/|$)/.test(path))return true;
  if(/^\/orders\/[^/]+\/refunds$/.test(path))return true;
  const value=body as {status?:unknown}|undefined;
  return /^\/orders\/[^/]+\/status$/.test(path)&&value?.status==='cancelled';
}

export function isAdminCommit(input:{path:string;method:string;changes:Array<{kind:string;before:Record<string,unknown>|null;after:Record<string,unknown>|null}>}):boolean {
  return isAdminOperation(input.path,input.method)||input.changes.some(row=>
    ['menu','category','recipe','production','purchase','supplier','settings','expense','media'].includes(row.kind)
    ||row.kind==='order'&&row.after?.status==='cancelled'&&row.before?.status!=='cancelled');
}

export function redactAdminSnapshot(data:Snapshot):Snapshot {
  return {...data,menu:data.menu.map(item=>({...item,cost:0})),recipes:[],
    inventory:data.inventory.map(item=>({...item,unitCost:0})),stockMovements:[],production:[],suppliers:[],purchases:[],staff:[],expenses:[],audit:[],
    orders:data.orders.map(order=>({...order,lines:order.lines.map(({unitCost:_cost,costBasis:_basis,...line})=>line)})),
  };
}

/** Cashier command replies need no captured purchasing costs. Stored rows and
 * replay identities retain the full values used for accurate offline sales. */
export function redactAdminResult<T>(value:T):T {
  if(Array.isArray(value))return value.map(redactAdminResult) as T;
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
    .filter(([key])=>!['unitCost','costBasis','cost'].includes(key))
    .map(([key,child])=>[key,redactAdminResult(child)])) as T;
  return value;
}
