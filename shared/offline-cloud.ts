import type {CloudKind,CloudChange} from './cloud-monitor.js';

/** Durable record effects from one validated, locally committed cashier command. */
export interface OfflineCloudEffect {
  kind:CloudKind;
  id:string;
  branchId:string|null;
  before:Record<string,unknown>|null;
  after:Record<string,unknown>|null;
}
export interface OfflineCloudCommit {
  sourceId:string;
  deviceId:string;
  transactionId:string;
  createdAt:string;
  path:string;
  method:string;
  /** Physical transaction was completed while cloud confirmation was unavailable. */
  offline?:boolean;
  changes:OfflineCloudEffect[];
}
export interface OfflineCloudState {
  sourceId:string;
  cloudVersion:number;
  records:CloudChange[];
  metadata:{settings:unknown;activeBranchId:string;deviceId:string};
}
export interface OfflineCloudResult {
  ok:true;
  transactionId:string;
  cloudVersion:number;
  warnings:string[];
}

/** Business operations use the same local validation online and offline. */
export function supportsOfflineCloudCommand(inputPath:string,inputMethod:string):boolean {
  const path=inputPath.split('?')[0].replace(/\/$/,'')||'/';
  const method=inputMethod.toUpperCase();
  if(method==='POST'&&['/orders','/customers','/shifts/open','/expenses','/held-bills','/categories','/menu','/inventory','/inventory/adjust','/inventory/wastage','/production','/suppliers','/purchases','/media'].includes(path))return true;
  if(method==='POST'&&/^\/(?:orders\/[^/]+\/(?:payments|refunds)|customers\/[^/]+\/collections|shifts\/[^/]+\/close)$/.test(path))return true;
  if(method==='PATCH'&&/^\/orders\/[^/]+\/status$/.test(path))return true;
  if(method==='PATCH'&&/^\/(?:categories|menu|inventory)\/[^/]+$/.test(path))return true;
  if(method==='DELETE'&&/^\/categories\/[^/]+$/.test(path))return true;
  if(method==='PUT'&&(path==='/settings'||/^\/menu\/[^/]+\/recipe$/.test(path)))return true;
  return ['PUT','DELETE'].includes(method)&&/^\/held-bills\/[^/]+$/.test(path);
}
