import {handleCashier} from '../../src/lib/local/cashier.js';
import {handleCatalog} from '../../src/lib/local/catalog.js';
import {bootstrap} from '../../src/lib/local/core.js';
import type {LocalStore} from '../../src/lib/local/db.js';
import type {LocalRequest} from '../../src/lib/local/types.js';
import type {User} from '../../shared/types.js';
import type {Projection} from './store.js';
import {recordKey} from './store.js';

/** The same validated business operations as device mode, inside a cloud CAS. */
export class ProjectionStore {
  constructor(readonly projection: Projection) {}
  async get<T>(kind: string,id: string): Promise<T|undefined> {return this.projection.records[recordKey(kind,id)]?.value as T|undefined;}
  async list<T>(kind: string,branchId?: string): Promise<T[]> {
    return Object.values(this.projection.records).filter(row=>row.kind===kind && (branchId===undefined||row.branchId===branchId)).map(row=>row.value as T);
  }
  async put<T extends {id:string;branchId?:string|null}>(kind: string,value:T):Promise<T> {
    this.projection.records[recordKey(kind,value.id)]={kind:kind as never,id:value.id,branchId:value.branchId??null,value:value as Record<string,unknown>};return value;
  }
  async remove(kind:string,id:string) {delete this.projection.records[recordKey(kind,id)];}
  async meta<T=string>(key:string) {return this.projection.metadata[key] as T|undefined;}
  async setMeta(key:string,value:unknown) {this.projection.metadata[key]=value;if(key==='settings')this.projection.records[recordKey('settings','settings')]={kind:'settings',id:'settings',branchId:null,value:value as Record<string,unknown>};}
}
export const monitorUser: User={id:'cloud-owner',name:'Cloud owner',initials:'CO',role:'owner',branchId:null};
export async function monitorBootstrap(projection:Projection,query:URLSearchParams) {
  return bootstrap(new ProjectionStore(projection) as unknown as LocalStore,monitorUser,query);
}
export async function monitorCommand(projection:Projection,path:string,method:string,body:Record<string,unknown>,query:URLSearchParams) {
  // Staff PINs, hardware channels, backup replacement and credentials stay outside this API.
  if (!/^\/(?:orders|held-bills|customers|shifts|expenses|inventory|categories|menu|recipes|production|purchases|suppliers|settings|reports)(?:\/|$)/.test(path)) {
    throw Object.assign(new Error('This operation is unavailable in the shared cloud workspace.'),{status:403,code:'CLOUD_OPERATION_FORBIDDEN'});
  }
  const request:LocalRequest={path,method,body,query,user:monitorUser,store:new ProjectionStore(projection) as unknown as LocalStore};
  const result=await handleCashier(request)??await handleCatalog(request);
  if(result===undefined)throw Object.assign(new Error('Cloud action not found.'),{status:404});
  return result;
}
