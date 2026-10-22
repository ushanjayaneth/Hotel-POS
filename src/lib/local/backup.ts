import {z} from 'zod';
import type {StaffMember} from '../../../shared/types';
import {assertMediaPayload,isProductImageReference,mediaIdFromReference} from '../../../shared/media';
import {browserDb} from '../db';
import {localDb, type LocalDatabase, type LocalRecord} from './db';
import {forgetLocalSession, getLocalUser, localSessionHash} from './auth';
import {localStorageError, uid} from './types';

const id = z.string().min(1).max(200);
const timestamp = z.iso.datetime();
const text = z.string();
const money = z.number().int().nonnegative().safe();
const signedMoney = z.number().int().safe();
const quantity = z.number().finite().positive();
const stockQuantity = z.number().finite().nonnegative();
const role = z.enum(['owner','manager','cashier','waiter','kitchen','storekeeper','accountant']);
const orderType = z.enum(['dine-in','takeaway','delivery']);
const paymentMethod = z.enum(['cash','card','qr','credit']);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const cartLine = z.looseObject({menuItemId:id,quantity,note:text,discount:money.optional()});
const payment = z.looseObject({id,orderId:id,method:paymentMethod,amount:money.positive(),received:money,change:money,reference:text,createdAt:timestamp});
const settings = z.looseObject({
  businessName:z.string().min(2).max(100),tagline:text,currency:z.literal('LKR'),
  taxRate:z.number().finite().min(0).max(100),serviceChargeRate:z.number().finite().min(0).max(100),
  receiptFooter:text,lowStockAlerts:z.boolean(),autoPrint:z.boolean(),language:z.enum(['en','si']),
  receiptPaperWidthMm:z.number().finite().min(40).max(120),receiptContentWidthMm:z.number().finite().min(20).max(120),
  receiptMarginMm:z.number().finite().min(0).max(15),receiptOffsetMm:z.number().finite().min(-30).max(30),receiptFontSize:z.number().finite().min(6).max(18),
}).refine(value=>value.receiptContentWidthMm+2*value.receiptMarginMm<=value.receiptPaperWidthMm,'Receipt margins exceed the paper width.')
  .refine(value=>Math.abs(value.receiptOffsetMm)<=(value.receiptPaperWidthMm-value.receiptContentWidthMm)/2-value.receiptMarginMm,'Receipt alignment exceeds the printable area.');
const workspace = z.looseObject({version:z.literal(1),workspaceId:id,deviceId:id,businessName:z.string().min(2).max(100),demo:z.boolean(),createdAt:timestamp});
const credential = z.object({staffId:id,salt:hex,hash:hex,iterations:z.number().int().min(100000).max(2000000),algorithm:z.literal('PBKDF2-SHA256'),version:z.literal(1),createdAt:timestamp,updatedAt:timestamp});
const record = z.object({kind:id,id,branchId:id.nullable(),value:z.record(z.string(),z.unknown()),createdAt:timestamp,updatedAt:timestamp});
const metadata = z.object({key:id,value:z.unknown()});
const command = z.object({id,actor:id,hash:hex,response:z.unknown(),createdAt:timestamp});
const change = z.object({kind:id,id,branchId:id.nullable(),value:z.unknown()});
const journal = z.object({id,sequence:z.number().int().positive().safe(),commandId:id,actor:id,action:id,branchId:id.nullable(),createdAt:timestamp,changes:z.array(change)});
const draft = z.object({id:z.string().startsWith('device:'),lines:z.array(cartLine),type:orderType,tableId:text,customerId:text.optional(),heldBillId:text.optional(),heldBillUpdatedAt:z.union([timestamp,z.literal('')]).optional(),note:text,discount:money,commandId:id,updatedAt:timestamp});
const pendingDrafts = z.object({version:z.literal(1),restoreId:id,drafts:z.array(draft)});
const payloadSchema = z.object({
  format:z.literal('demo-hotel-device-data'),version:z.literal(1),createdAt:timestamp,
  tables:z.object({records:z.array(record),metadata:z.array(metadata),credentials:z.array(credential),commands:z.array(command),journal:z.array(journal)}).strict(),
  drafts:z.array(draft),
}).strict();
export type BackupPayload = z.infer<typeof payloadSchema>;

// Preserve immutable costing fields and other newer fields while checking
// every essential shape read by the workspace UI and transaction engine.
const recordSchemas: Record<string,z.ZodType> = {
  branch:z.looseObject({id,name:text,nameSi:text,code:text,address:text,phone:text}),
  category:z.looseObject({id,name:text,nameSi:text,icon:text}),
  menu:z.looseObject({id,name:text,nameSi:text,description:text,categoryId:id,price:money,cost:money,image:text.refine(isProductImageReference,'A product photo reference is invalid.'),available:z.boolean(),stockMode:z.enum(['prepared','recipe','untracked']),preparationMinutes:z.number().int().nonnegative(),enabled:z.boolean().optional(),barcode:text.optional(),sku:text.optional(),reorderLevel:stockQuantity.optional(),badge:text.optional()}),
  recipe:z.looseObject({id,batchYield:z.number().finite().min(1).max(100000).optional(),ingredients:z.array(z.looseObject({key:id,quantity}))}),
  table:z.looseObject({id,branchId:id,name:text,seats:z.number().int().positive(),area:text,status:z.enum(['available','occupied','reserved']),orderId:id.optional()}),
  order:z.looseObject({id,branchId:id,number:id,type:orderType,tableId:id.nullable(),customerId:id.nullable(),status:z.enum(['new','preparing','ready','served','completed','cancelled']),paymentStatus:z.enum(['unpaid','partial','paid','refunded']),subtotal:money,discount:money,cartDiscount:money.optional(),tax:money,serviceCharge:money,total:money,paid:money,refunded:money,note:text,createdAt:timestamp,updatedAt:timestamp,createdBy:id,version:z.number().int().positive().safe(),lines:z.array(z.looseObject({id,menuItemId:id,name:text,nameSi:text,quantity,unitPrice:money,lineTotal:money,note:text,discount:money.optional(),unitCost:money.optional(),costBasis:z.enum(['captured','estimated']).optional()})),payments:z.array(payment)}),
  held:z.looseObject({id,branchId:id,label:text,type:orderType,tableId:id.nullable(),customerId:id.nullable(),note:text,discount:money,lines:z.array(cartLine),createdAt:timestamp,updatedAt:timestamp,createdBy:id,status:z.enum(['held','resumed','discarded']),resumedOrderId:id.nullable()}),
  credit:z.looseObject({id,branchId:id,customerId:id,type:z.enum(['sale','collection','refund']),amount:money.positive(),method:paymentMethod,orderId:id.nullable(),reference:text,note:text,createdAt:timestamp,createdBy:id}),
  refund:z.looseObject({id,branchId:id,orderId:id,amount:money.positive(),method:paymentMethod,reason:text,createdAt:timestamp,createdBy:id}),
  inventory:z.looseObject({id,branchId:id,name:text,nameSi:text,category:z.enum(['ingredient','prepared','packaging','resale']),unit:text,quantity:stockQuantity,minimum:stockQuantity,unitCost:money,supplierId:id.nullable(),menuItemId:id.nullable(),updatedAt:timestamp}),
  movement:z.looseObject({id,branchId:id,itemId:id,type:text,quantity:z.number().finite(),reason:text,createdAt:timestamp,createdBy:id}),
  production:z.looseObject({id,branchId:id,menuItemId:id,name:text,quantity,cost:money,note:text,createdAt:timestamp,createdBy:id}),
  supplier:z.looseObject({id,name:text,phone:text,email:text,balance:money}),
  purchase:z.looseObject({id,branchId:id,supplierId:id,supplierName:text,invoiceNumber:text,total:money,status:text,createdAt:timestamp,lines:z.array(z.looseObject({itemId:id,name:text,quantity,unitCost:money,total:money}))}),
  customer:z.looseObject({id,name:text,phone:text,email:text,visits:z.number().int().nonnegative().safe(),spent:money,balance:signedMoney,points:z.number().finite().nonnegative(),createdAt:timestamp}),
  staff:z.looseObject({id,name:z.string().min(2),role,branchId:id.nullable(),initials:text,active:z.boolean(),phone:text,lastActive:timestamp.nullable()}),
  expense:z.looseObject({id,branchId:id,category:text,description:text,amount:money.positive(),paymentMethod:text,createdAt:timestamp,createdBy:id}),
  shift:z.looseObject({id,branchId:id,openedBy:id,openedAt:timestamp,openingFloat:money,status:z.enum(['open','closed']),closedAt:timestamp.nullable(),countedCash:money.nullable(),expectedCash:signedMoney,variance:signedMoney.nullable()}),
  audit:z.looseObject({id,branchId:id,action:text,actor:text,detail:text,createdAt:timestamp}),
  media:z.looseObject({id,branchId:z.null(),mime:z.enum(['image/jpeg','image/png','image/webp']),data:z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),byteLength:z.number().int().positive().max(999999),width:z.number().int().positive().max(8192),height:z.number().int().positive().max(8192),createdAt:timestamp}),
};

function check(condition:unknown,message:string):asserts condition {if(!condition)throw new Error(message);}
function unique(values:string[],name:string) {check(new Set(values).size===values.length,`The backup contains duplicate ${name}.`);}
function jsonSafe(value:unknown,depth=0):void {
  check(depth<100,'The backup contains an excessively nested value.');
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'){check(Number.isFinite(value),'The backup contains an invalid number.');return;}
  if(Array.isArray(value)){for(const item of value)jsonSafe(item,depth+1);return;}
  check(typeof value==='object'&&value!==null&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null),'The backup contains a non-JSON value.');
  for(const [key,item] of Object.entries(value)){
    check(!['__proto__','prototype','constructor'].includes(key),'The backup contains an unsafe field.');
    jsonSafe(item,depth+1);
  }
}

/** Validate decrypted input before either showing its summary or changing data. */
export function validateDeviceBackupPayload(input:unknown):BackupPayload {
  jsonSafe(input);
  const value=payloadSchema.parse(input);
  const rows=value.tables.records;
  const keys=new Set<string>();
  for(const row of rows){
    check(Boolean(recordSchemas[row.kind]),`The backup contains an unsupported record kind: ${row.kind}.`);
    const key=`${row.kind}:${row.id}`;
    check(!keys.has(key),'The backup contains duplicate business records.');keys.add(key);
    const item=row.value;
    check(item.id===row.id,'A backup record ID does not match its data.');
    check((item.branchId??null)===row.branchId,'A backup record branch does not match its data.');
    recordSchemas[row.kind].parse(item);
    if(row.kind==='media'){
      assertMediaPayload(item);
    }
    if(row.kind==='order'){
      const lines=item.lines as {id:string}[],payments=item.payments as {id:string;orderId:string}[];
      unique(lines.map(line=>line.id),'order line IDs');unique(payments.map(entry=>entry.id),'payment IDs');
      check(payments.every(entry=>entry.orderId===row.id),'A payment belongs to a different order.');
    }
  }
  for(const name of ['metadata','credentials','commands','journal'] as const){
    const ids=value.tables[name].map(row=>'key'in row?row.key:'staffId'in row?row.staffId:row.id);
    unique(ids,name);
  }
  unique(value.drafts.map(item=>item.id),'draft IDs');
  unique(value.tables.journal.map(item=>String(item.sequence)),'journal sequence numbers');
  const meta=new Map(value.tables.metadata.map(item=>[item.key,item.value]));
  const info=workspace.parse(meta.get('workspace'));
  check(meta.get('storageFormat')===1,'The backup storage schema is not supported.');
  settings.parse(meta.get('settings'));
  check(meta.get('deviceId')===info.deviceId,'The backup device identity is inconsistent.');
  const sequence=z.number().int().nonnegative().safe().parse(meta.get('journalSequence'));
  check(value.tables.journal.every(entry=>entry.sequence<=sequence),'The backup journal counter is older than its transactions.');
  for(const [key,count] of meta)if(key.startsWith('receipt:'))z.number().int().nonnegative().safe().parse(count);
  check(rows.some(row=>row.kind==='branch'),'The backup has no branch.');
  const has=(kind:string,key:unknown)=>typeof key==='string'&&keys.has(`${kind}:${key}`);
  const branch=(key:unknown)=>key===null||has('branch',key);
  check(has('branch',meta.get('activeBranchId')),'The backup active branch is missing.');
  const owners=rows.filter(row=>row.kind==='staff'&&row.value.role==='owner'&&row.value.active);
  check(owners.some(owner=>value.tables.credentials.some(item=>item.staffId===owner.id)),'This backup has no active owner credentials.');
  for(const entry of value.tables.credentials)check(has('staff',entry.staffId),'The backup credentials do not match its staff records.');
  for(const row of rows){
    const item=row.value;
    check(branch(row.branchId),'A backup record refers to a missing branch.');
    if('createdBy'in item)check(has('staff',item.createdBy),'A backup record refers to a missing staff account.');
    if(row.kind==='shift')check(has('staff',item.openedBy),'A cash shift refers to a missing staff account.');
    if(row.kind==='menu'){
      check(has('category',item.categoryId),'A product refers to a missing category.');
      const photo=mediaIdFromReference(item.image as string);
      check(photo===null||has('media',photo),'A product refers to a missing uploaded photo.');
    }
    if(row.kind==='recipe')check(has('menu',row.id),'A recipe refers to a missing product.');
    if(['refund','credit'].includes(row.kind)&&item.orderId!==null)check(has('order',item.orderId),'A financial record refers to a missing order.');
    if(row.kind==='credit')check(has('customer',item.customerId),'A credit record refers to a missing customer.');
  }
  for(const entry of value.tables.commands)check(has('staff',entry.actor),'A command refers to a missing staff account.');
  const commands=new Set(value.tables.commands.map(item=>item.id));
  for(const entry of value.tables.journal){
    check(branch(entry.branchId)&&has('staff',entry.actor),'A journal entry refers to a missing branch or staff account.');
    check(commands.has(entry.commandId),'A journal entry has no command acknowledgement.');
    for(const item of entry.changes){
      check(Boolean(recordSchemas[item.kind])||item.kind==='settings','The backup journal contains an unsupported record kind.');
      check(branch(item.branchId),'A journal change refers to a missing branch.');
      if(item.kind==='settings'){check(item.id==='settings'&&item.branchId===null,'A settings journal entry is invalid.');settings.parse(item.value);}
      else{
        const changed=z.record(z.string(),z.unknown()).parse(item.value);
        check(changed.id===item.id,'A journal record ID does not match its data.');
        if(changed.deleted!==true){
          check((changed.branchId??null)===item.branchId,'A journal record branch does not match its data.');
          recordSchemas[item.kind].parse(changed);
          if(item.kind==='media')assertMediaPayload(changed);
        }
      }
    }
  }
  const restored=meta.get('pendingRestoredDrafts');
  if(restored!==undefined)pendingDrafts.parse(restored);
  for(const item of value.drafts)check(has('branch',item.id.slice('device:'.length)),'A draft refers to a missing branch.');
  return value;
}

async function requireOwner(db:LocalDatabase=localDb){const user=await getLocalUser(db);check(user?.role==='owner','Only the device workspace owner can export or replace its database.');return user;}
async function requireTransactionOwner(db:LocalDatabase,tokenHash:string|null){
  const session=tokenHash?await db.sessions.get(tokenHash):undefined;
  const staff=session?(await db.records.get(['staff',session.staffId]))?.value as StaffMember|undefined:undefined;
  check(session&&session.expiresAt>Date.now()&&staff?.active&&staff.role==='owner','Only the device workspace owner can export or replace its database.');
}

/** Read all business tables from one consistent, owner-authorized transaction. */
export async function buildBackupPayload(db:LocalDatabase=localDb):Promise<BackupPayload>{
  await requireOwner(db);
  const tokenHash=await localSessionHash(db);
  const tables=await db.transaction('r',db.tables,async()=>{
    await requireTransactionOwner(db,tokenHash);
    return{records:await db.records.toArray(),metadata:await db.metadata.toArray(),credentials:await db.credentials.toArray(),commands:await db.commands.toArray(),journal:await db.journal.toArray()};
  });
  // A prior restore may have committed before the separate drafts database was
  // writable. Its committed drafts take precedence over an older UI draft.
  const pending=tables.metadata.find(item=>item.key==='pendingRestoredDrafts')?.value;
  const drafts=pending!==undefined?pendingDrafts.parse(pending).drafts:await browserDb.drafts.filter(item=>item.id.startsWith('device:')).toArray();
  // Operational authentication state is deliberately excluded from the file.
  tables.metadata=tables.metadata.filter(item=>!['loginThrottle','pendingRestoredDrafts'].includes(item.key)&&!item.key.startsWith('cloudMonitor:'));
  return validateDeviceBackupPayload({format:'demo-hotel-device-data',version:1,createdAt:new Date().toISOString(),tables,drafts});
}

function cryptoJob(operation:'encrypt'|'decrypt',value:unknown,password:string):Promise<unknown>{
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./backup.worker.ts',import.meta.url),{type:'module'});
    worker.onmessage=event=>{worker.terminate();event.data.ok?resolve(event.data.result):reject(new Error(event.data.error));};
    worker.onerror=()=>{worker.terminate();reject(new Error('The backup could not be processed. Keep this app open and try again.'));};
    worker.postMessage({operation,value,password});
  });
}
export async function createEncryptedBackup(password:string):Promise<{text:string;filename:string;recordCount:number}>{
  const value=await buildBackupPayload();
  const encrypted=await cryptoJob('encrypt',value,password) as string;
  return{text:encrypted,filename:`demo-hotel-device-${new Date().toISOString().replace(/[:.]/g,'-')}.hotelbackup`,recordCount:value.tables.records.length};
}
export async function markBackupDownloaded(recordCount:number){await localDb.transaction('rw',localDb.metadata,async()=>{await localDb.metadata.put({key:'lastBackup',value:new Date().toISOString()});await localDb.metadata.put({key:'lastBackupRecords',value:recordCount});});}
export function downloadBackupFile(value:string,filename:string){
  const url=URL.createObjectURL(new Blob([value],{type:'application/octet-stream'}));const link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
export async function inspectEncryptedBackup(file:File,password:string){
  const value=validateDeviceBackupPayload(await cryptoJob('decrypt',await file.text(),password));
  const info=workspace.parse(value.tables.metadata.find(item=>item.key==='workspace')?.value);
  return{payload:value,workspace:info,records:value.tables.records.length,createdAt:value.createdAt};
}

/** Retry the second database step safely after a reload, interruption or quota failure. */
export async function recoverRestoredDrafts(db:LocalDatabase=localDb):Promise<{recovered:boolean;pending:boolean}>{
  const raw=(await db.metadata.get('pendingRestoredDrafts'))?.value;
  if(raw===undefined)return{recovered:false,pending:false};
  const pending=pendingDrafts.parse(raw);
  try{
    await browserDb.transaction('rw',browserDb.drafts,async()=>{
      await browserDb.drafts.filter(item=>item.id.startsWith('device:')).delete();
      await browserDb.drafts.bulkPut(pending.drafts);
    });
    await db.transaction('rw',db.metadata,async()=>{
      const current=(await db.metadata.get('pendingRestoredDrafts'))?.value as {restoreId?:unknown}|undefined;
      if(current?.restoreId===pending.restoreId)await db.metadata.delete('pendingRestoredDrafts');
    });
    const newer=await db.metadata.get('pendingRestoredDrafts');
    return{recovered:true,pending:newer!==undefined};
  }catch{
    // Business records have committed. Retain the durable pending copy and do
    // not falsely report that the entire restore failed.
    return{recovered:false,pending:true};
  }
}

/** Replace existing data only after decryption, validation and explicit UI confirmation. */
export async function restoreDeviceBackup(input:BackupPayload,db:LocalDatabase=localDb):Promise<{draftRecoveryPending:boolean}>{
  const value=validateDeviceBackupPayload(input);
  const tokenHash=await localSessionHash(db);
  const original=workspace.parse(value.tables.metadata.find(item=>item.key==='workspace')?.value);
  const deviceId=uid('device'),restoreId=uid('restore'),restoredAt=new Date().toISOString();
  const metadataRows=value.tables.metadata.filter(item=>!['pendingRestoredDrafts','loginThrottle'].includes(item.key)&&!item.key.startsWith('photo-uploaded:')&&!item.key.startsWith('cloudMonitor:'));
  try{
    await db.transaction('rw',db.tables,async()=>{
      const populated=await db.records.count()||await db.credentials.count()||await db.commands.count()||await db.journal.count()
        ||(await db.metadata.toArray()).some(item=>!['storagePersistenceAttempted','storagePersistenceGranted'].includes(item.key));
      // A damaged setup marker must never make business data replaceable by
      // an unauthenticated import.
      if(populated)await requireTransactionOwner(db,tokenHash);
      for(const table of [db.records,db.metadata,db.credentials,db.commands,db.journal,db.sessions])await table.clear();
      await db.records.bulkPut(value.tables.records as LocalRecord[]);
      await db.metadata.bulkPut(metadataRows);
      await db.credentials.bulkPut(value.tables.credentials);
      await db.commands.bulkPut(value.tables.commands);
      await db.journal.bulkPut(value.tables.journal);
      await db.metadata.bulkPut([
        {key:'deviceId',value:deviceId},{key:'workspace',value:{...original,deviceId}},
        {key:'restoredFromDeviceId',value:original.deviceId},{key:'lastRestore',value:restoredAt},
        {key:'storagePersistenceAttempted',value:true},
        {key:'pendingRestoredDrafts',value:{version:1,restoreId,drafts:value.drafts}},
      ]);
    });
  }catch(error){throw localStorageError(error);}
  // Tokens from the replaced database must never authenticate imported staff.
  forgetLocalSession(db);
  const drafts=await recoverRestoredDrafts(db);
  if(typeof window!=='undefined')window.dispatchEvent(new Event('local-workspace-restored'));
  return{draftRecoveryPending:drafts.pending};
}
export async function backupOwnerName(){const staff=await localDb.records.where('kind').equals('staff').toArray();return staff.map(row=>row.value as StaffMember).find(item=>item.role==='owner'&&item.active)?.name||'Owner';}
