import Dexie, {type EntityTable} from 'dexie';
import type {Snapshot,CartLine,Order} from '../../shared/types';
export interface Draft {id:string;lines:CartLine[];type:Order['type'];tableId:string;customerId?:string;heldBillId?:string;heldBillUpdatedAt?:string;note:string;discount:number;commandId:string;updatedAt:string}
export const browserDb = new Dexie('demo-hotel-device') as Dexie & {
  snapshots: EntityTable<{id:string;data:Snapshot;savedAt:string},'id'>;
  drafts: EntityTable<Draft,'id'>;
};
browserDb.version(1).stores({snapshots:'id',drafts:'id,updatedAt'});
