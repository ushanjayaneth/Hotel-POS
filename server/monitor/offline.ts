import {z} from 'zod';
import {createHash} from 'node:crypto';
import {CLOUD_MONITOR_KINDS,type CloudChange} from '../../shared/cloud-monitor.js';
import {supportsOfflineCloudCommand,type OfflineCloudCommit,type OfflineCloudEffect,type OfflineCloudResult,type OfflineCloudState} from '../../shared/offline-cloud.js';
import {recordKey,type Projection} from './store.js';
import {catalogKinds,mergeCatalogFields,sameCatalogValue,validateCatalogRecord,validateMovement} from './offline-catalog.js';
import {assertMediaPayload} from '../../shared/media.js';

const identifier=z.string().min(1).max(160);
const row=z.record(z.string(),z.unknown());
export const offlineCommitSchema=z.object({
  sourceId:identifier.regex(/^[A-Za-z0-9_-]+$/),deviceId:identifier.regex(/^[A-Za-z0-9_-]+$/),transactionId:identifier,
  createdAt:z.iso.datetime(),path:z.string().max(300),method:z.enum(['POST','PUT','PATCH','DELETE']),offline:z.boolean().optional(),
  changes:z.array(z.object({kind:z.enum(CLOUD_MONITOR_KINDS),id:identifier,branchId:identifier.nullable(),before:row.nullable(),after:row.nullable()}).strict()).min(1).max(1000),
}).strict();
const stable=(value:unknown):string=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(stable).join(',')}]`:`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable((value as Record<string,unknown>)[key])}`).join(',')}}`;
const equal=(a:unknown,b:unknown)=>stable(a)===stable(b);
const fail=(message:string,code='OFFLINE_RECONCILIATION_CONFLICT'):never=>{throw Object.assign(new Error(message),{status:409,code});};
const check=(value:unknown,message:string,code?:string):void=>{if(!value)fail(message,code);};
const money=(value:unknown,name:string):number=>{
  check(Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=Number.MAX_SAFE_INTEGER,`${name} is invalid.`,'INVALID_OFFLINE_RECORD');return Number(value);
};
const quantity=(value:unknown):number=>{check(typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e12,'The offline stock quantity is invalid.','INVALID_OFFLINE_RECORD');return Number(value);};
const round=(value:number)=>Math.round(value*10000)/10000;
const without=(value:Record<string,unknown>,keys:string[])=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)));
const immutable=(before:Record<string,unknown>,after:Record<string,unknown>,allowed:string[],message:string)=>check(equal(without(before,allowed),without(after,allowed)),message,'INVALID_OFFLINE_RECORD');

export function offlineCloudState(projection:Projection):OfflineCloudState {
  // Only business rows are exported. Credentials, server command deduplication,
  // bearer grants and server metadata never enter the browser replica.
  return {sourceId:projection.source.sourceId,cloudVersion:projection.source.dataVersion??0,records:Object.values(projection.records).filter(row=>row.kind!=='media'),metadata:{
    settings:projection.metadata.settings,
    activeBranchId:String(projection.metadata.activeBranchId??Object.values(projection.records).find(value=>value.kind==='branch')?.id??'b1'),
    deviceId:projection.source.sourceId,
  }};
}

function validateOrder(value:Record<string,unknown>,allowOverpayment=false) {
  check(typeof value.id==='string'&&typeof value.number==='string'&&typeof value.branchId==='string','Offline bill identity is invalid.','INVALID_OFFLINE_RECORD');
  check(['dine-in','takeaway','delivery'].includes(String(value.type))&&['new','preparing','ready','served','completed','cancelled'].includes(String(value.status)),'Offline bill status is invalid.','INVALID_OFFLINE_RECORD');
  const lines=value.lines as Record<string,unknown>[];
  check(Array.isArray(lines)&&lines.length>0&&lines.length<=100,'Offline bill lines are invalid.','INVALID_OFFLINE_RECORD');
  let subtotal=0,discounts=0;
  for(const line of lines){
    check(Number.isSafeInteger(line.quantity)&&Number(line.quantity)>0&&Number(line.quantity)<=1000,'Offline line quantity is invalid.','INVALID_OFFLINE_RECORD');
    const gross=money(line.unitPrice,'Unit price')*Number(line.quantity),discount=money(line.discount??0,'Line discount');
    check(Number.isSafeInteger(gross)&&discount<=gross&&line.lineTotal===gross-discount,'Offline line total is invalid.','INVALID_OFFLINE_RECORD');
    if(line.unitCost!==undefined)money(line.unitCost,'Captured unit cost');
    subtotal+=gross;discounts+=discount;
  }
  const discount=money(value.discount,'Bill discount'),cart=money(value.cartDiscount??discount-discounts,'Cart discount');
  check(value.subtotal===subtotal&&discount===discounts+cart&&discount<=subtotal,'Offline discounts do not balance.','INVALID_OFFLINE_RECORD');
  const total=money(value.total,'Bill total');
  check(total===subtotal-discount+money(value.tax,'Tax')+money(value.serviceCharge,'Service charge'),'Offline bill total does not balance.','INVALID_OFFLINE_RECORD');
  const payments=value.payments as Record<string,unknown>[];
  check(Array.isArray(payments)&&payments.length<=1000,'Offline payments are invalid.','INVALID_OFFLINE_RECORD');
  const ids=new Set<string>();let paid=0;
  for(const payment of payments){
    check(typeof payment.id==='string'&&!ids.has(payment.id)&&payment.orderId===value.id,'Offline payment identity is invalid.','INVALID_OFFLINE_RECORD');ids.add(String(payment.id));
    check(['cash','card','qr','credit'].includes(String(payment.method)),'Offline payment method is invalid.','INVALID_OFFLINE_RECORD');
    const amount=money(payment.amount,'Payment amount'),received=money(payment.received,'Received amount'),change=money(payment.change,'Cash change');
    check(amount>0&&(payment.method==='cash'?received>=amount&&change===received-amount:received===amount&&change===0),'Offline payment does not balance.','INVALID_OFFLINE_RECORD');
    paid+=amount;
  }
  check(value.paid===paid&&(allowOverpayment||paid<=total)&&money(value.refunded,'Refund amount')<=paid,'Offline payment totals are invalid.','INVALID_OFFLINE_RECORD');
  check(Number.isSafeInteger(value.version)&&Number(value.version)>0,'Offline bill version is invalid.','INVALID_OFFLINE_RECORD');
}

const allowedKinds=new Set(['order','inventory','movement','credit','customer','shift','audit','held','table','expense','refund','category','menu','recipe','settings','supplier','purchase','production','media']);
const appendKinds=new Set(['movement','credit','audit','expense','refund','purchase','production','media']);
const orderMutable=['payments','paid','refunded','paymentStatus','status','updatedAt','version','customerId'];
function commandKinds(path:string):Set<string> {
  if(path==='/media')return new Set(['media','audit']);
  if(path.startsWith('/categories'))return new Set(['category','audit']);
  if(/^\/menu\/[^/]+\/recipe$/.test(path))return new Set(['recipe','audit']);
  if(path.startsWith('/menu'))return new Set(['menu','audit']);
  if(path.startsWith('/inventory'))return new Set(['inventory','movement','audit']);
  if(path==='/production')return new Set(['production','inventory','movement','audit']);
  if(path==='/purchases')return new Set(['purchase','inventory','movement','supplier','audit']);
  if(path==='/suppliers')return new Set(['supplier','audit']);
  if(path==='/settings')return new Set(['settings','audit']);
  if(path==='/orders')return new Set(['order','inventory','movement','audit','held','table']);
  if(/\/payments$/.test(path))return new Set(['order','shift','customer','credit','audit','table']);
  if(/\/refunds$/.test(path))return new Set(['order','shift','customer','credit','refund','audit']);
  if(/\/status$/.test(path))return new Set(['order','audit','table']);
  if(path==='/customers')return new Set(['customer','audit']);
  if(/\/collections$/.test(path))return new Set(['customer','credit','shift','audit']);
  if(path.startsWith('/shifts/'))return new Set(['shift','audit']);
  if(path==='/expenses')return new Set(['expense','shift','audit']);
  return new Set(['held','audit']);
}

/** Reconcile physical transactions, never replace a device's whole snapshot. */
export function applyOfflineCommit(projection:Projection,input:OfflineCloudCommit):Omit<OfflineCloudResult,'cloudVersion'> {
  check(supportsOfflineCloudCommand(input.path,input.method),'This action needs an online cloud connection.','OFFLINE_OPERATION_FORBIDDEN');
  const path=input.path.split('?')[0].replace(/\/$/,'')||'/';
  const keys=new Set<string>(),warnings:string[]=[],routeKinds=commandKinds(path);
  const warn=(message:string)=>{if(!warnings.includes(message))warnings.push(message);};
  const get=(kind:string,id:string)=>projection.records[recordKey(kind,id)]?.value??(kind==='settings'?projection.metadata.settings as Record<string,unknown>|undefined:undefined);
  const put=(effect:OfflineCloudEffect,value:Record<string,unknown>)=>{
    projection.records[recordKey(effect.kind,effect.id)]={kind:effect.kind,id:effect.id,branchId:effect.branchId,value};
    if(effect.kind==='settings'){projection.metadata.settings=value;projection.source.businessName=String(value.businessName);}
  };
  const created=Date.parse(input.createdAt);
  check(Number.isFinite(created),'Offline transaction time is invalid.','INVALID_OFFLINE_RECORD');
  const editWriter=JSON.stringify([input.deviceId,input.transactionId]);
  type FieldClock={time:number;writer:string};
  const clocks=(projection.metadata.offlineCatalogFieldClocks??{}) as Record<string,Record<string,FieldClock>>;
  const conflicts:Record<string,unknown>[]=[];
  const mergeFields=(effect:OfflineCloudEffect,current:Record<string,unknown>,excluded:string[]=[])=>{
    const before=effect.before!,after=effect.after!,key=recordKey(effect.kind,effect.id),fieldClocks=clocks[key]??{};
    const next=mergeCatalogFields(effect.kind,before,after,current,excluded,input.offline?field=>{
      const previous=fieldClocks[field]??{time:Date.parse(String(current.updatedAt??projection.source.updatedAt)),writer:''};
      const useIncoming=created>previous.time||created===previous.time&&editWriter>previous.writer;
      warn(`The ${effect.kind} ${field} changed on another device. The later field edit was kept; both values are recorded in the sync review log.`);
      conflicts.push({kind:effect.kind,id:effect.id,field,existing:current[field]??null,proposed:after[field]??null,kept:useIncoming?'proposed':'existing',existingEdit:new Date(previous.time).toISOString(),proposedEdit:input.createdAt});
      return useIncoming;
    }:undefined);
    for(const field of new Set([...Object.keys(before),...Object.keys(after)])){
      if(excluded.includes(field)||sameCatalogValue(before[field],after[field])||!sameCatalogValue(next[field],after[field]))continue;
      fieldClocks[field]={time:created,writer:editWriter};
    }
    clocks[key]=fieldClocks;projection.metadata.offlineCatalogFieldClocks=clocks;return next;
  };
  for(const effect of input.changes){
    const key=recordKey(effect.kind,effect.id);
    check(!keys.has(key),'An offline transaction contains duplicate record effects.','INVALID_OFFLINE_RECORD');keys.add(key);
    check(allowedKinds.has(effect.kind),'This kind of record cannot be changed by offline billing.','OFFLINE_OPERATION_FORBIDDEN');
    check(routeKinds.has(effect.kind),'An offline command contains unrelated record changes.','OFFLINE_OPERATION_FORBIDDEN');
    check(effect.after!==null||effect.kind==='category'&&input.method==='DELETE','Offline billing cannot delete business history.','OFFLINE_OPERATION_FORBIDDEN');
    for(const value of [effect.before,effect.after])if(value){
      check(effect.kind==='settings'?effect.id==='settings':value.id===effect.id,'Offline record identity does not match.','INVALID_OFFLINE_RECORD');
      check((value.branchId??null)===effect.branchId,'Offline record branch does not match.','INVALID_OFFLINE_RECORD');
      validateCatalogRecord(effect.kind,value);
    }
    if(effect.branchId)check(get('branch',effect.branchId),'The branch for this offline transaction no longer exists.');
    if(effect.kind==='order'){
      if(effect.before)validateOrder(effect.before,true);
      validateOrder(effect.after!,Boolean(effect.before&&Number(effect.before.paid)>Number(effect.before.total)));
    }
  }
  const branchCash=new Map<string,number>();
  const cash=(branchId:string|null,amount:number)=>{if(branchId)branchCash.set(branchId,(branchCash.get(branchId)??0)+amount);};
  for(const effect of input.changes){
    const after=effect.after,before=effect.before;if(!after)continue;
    if(effect.kind==='order'){
      const prior=(before?.payments??[]) as Record<string,unknown>[];
      for(const payment of after.payments as Record<string,unknown>[])if(payment.method==='cash'&&!prior.some(value=>value.id===payment.id))cash(effect.branchId,Number(payment.amount));
    }
    if(effect.kind==='credit'&&after.type==='collection'&&after.method==='cash')cash(effect.branchId,money(after.amount,'Collection amount'));
    if(effect.kind==='expense'&&after.paymentMethod==='cash')cash(effect.branchId,-money(after.amount,'Expense amount'));
    if(effect.kind==='refund'&&after.method==='cash')cash(effect.branchId,-money(after.amount,'Refund amount'));
    if(effect.kind==='movement')check(input.changes.some(value=>value.kind==='inventory'&&value.id===after.itemId),'A stock movement is missing its inventory change.','INVALID_OFFLINE_RECORD');
  }
  for(const [branchId,amount] of branchCash){
    const shifts=input.changes.filter(value=>value.kind==='shift'&&value.branchId===branchId&&value.before);
    check(shifts.length===1&&Number(shifts[0].after!.expectedCash)-Number(shifts[0].before!.expectedCash)===amount,'The offline cash payment does not match the recorded drawer change.','INVALID_OFFLINE_RECORD');
  }
  for(const effect of input.changes.filter(value=>value.kind==='shift'&&value.before))check(Number(effect.after!.expectedCash)-Number(effect.before!.expectedCash)===(branchCash.get(effect.branchId!)??0),'The offline drawer change has no matching cash transaction.','INVALID_OFFLINE_RECORD');
  // Financial receipts and movement logs are immutable and their IDs are unique
  // across devices. An occupied ID is never silently overwritten.
  for(const effect of input.changes.filter(value=>appendKinds.has(value.kind))){
    check(effect.before===null,'An offline ledger entry cannot replace earlier history.','INVALID_OFFLINE_RECORD');
    const existing=get(effect.kind,effect.id);
    check(!existing,`The ${effect.kind} entry already exists with a different transaction.`);
    const value=effect.after!;
    if(effect.kind==='media'){
      let photo;
      try{photo=assertMediaPayload(value);}catch(error){return fail((error as Error).message,'INVALID_OFFLINE_RECORD');}
      check(photo.byteLength<=450_000,'Compress product photos to at most 450 KB before syncing.','INVALID_OFFLINE_RECORD');
      check(z.iso.datetime().safeParse(value.createdAt).success,'The product photo timestamp is invalid.','INVALID_OFFLINE_RECORD');
      // The handler stores immutable photo bytes outside the business projection,
      // so every subsequent bill CAS does not retransmit the image library.
      continue;
    }
    if(['credit','expense','refund'].includes(effect.kind))check(money(value.amount,'Ledger amount')>0,'The ledger amount must be positive.','INVALID_OFFLINE_RECORD');
    if(effect.kind==='credit')check(['sale','collection','refund'].includes(String(value.type))&&typeof value.customerId==='string'&&(value.type==='collection'?['cash','card','qr'].includes(String(value.method)):value.method==='credit'&&typeof value.orderId==='string'),'The Customer Loan entry is invalid.','INVALID_OFFLINE_RECORD');
    if(effect.kind==='movement')validateMovement(effect,path);
    if(effect.kind==='purchase'){
      const duplicate=Object.values(projection.records).some(row=>row.kind==='purchase'&&row.branchId===effect.branchId&&row.value.supplierId===value.supplierId&&String(row.value.invoiceNumber).toLowerCase()===String(value.invoiceNumber).toLowerCase());
      check(!duplicate,'This supplier invoice has already been received. The pending receipt remains saved for review.','DUPLICATE_INVOICE');
    }
    put(effect,value);
  }
  for(const effect of input.changes.filter(value=>!appendKinds.has(value.kind))){
    const before=effect.before,after=effect.after!,current=get(effect.kind,effect.id);
    if(catalogKinds.has(effect.kind)){
      if(!after){
        check(effect.kind==='category'&&before&&current&&equal(current,before),'This category changed on another device. The pending deletion is still saved.','OFFLINE_CATALOG_CONFLICT');
        check(!Object.values(projection.records).some(row=>row.kind==='menu'&&row.value.categoryId===effect.id),'Move this category\'s products before deleting it.','CATEGORY_IN_USE');
        delete projection.records[recordKey(effect.kind,effect.id)];continue;
      }
      if(!before){check(!current,`The offline ${effect.kind} ID already exists.`);put(effect,after);}
      else {
        check(current,`The offline ${effect.kind} record no longer exists.`);
        if(effect.kind==='supplier'){
          immutable(before,after,['balance'],'Purchases cannot edit supplier contact details.');
          const added=money(after.balance,'Supplier balance')-money(before.balance,'Previous supplier balance');
          const received=input.changes.filter(value=>value.kind==='purchase'&&value.after?.supplierId===effect.id).reduce((sum,value)=>sum+Number(value.after!.total),0);
          check(added===received,'The supplier balance does not match the received purchase costs.','INVALID_OFFLINE_RECORD');
          put(effect,{...current!,balance:money(current!.balance,'Current supplier balance')+added});
        }else {
          const merged=mergeFields(effect,current!);validateCatalogRecord(effect.kind,merged);put(effect,merged);
        }
      }
      continue;
    }
    if(!before){
      check(!current,`The offline ${effect.kind} ID already exists.`);
      check(['order','customer','shift','held','inventory'].includes(effect.kind),'This offline operation cannot create this kind of record.','OFFLINE_OPERATION_FORBIDDEN');
      if(effect.kind==='inventory'){
        const movements=input.changes.filter(value=>value.kind==='movement'&&value.after?.itemId===effect.id).reduce((sum,value)=>sum+Number(value.after!.quantity),0);
        check(path==='/inventory'&&Number(after.quantity)>=0&&Math.abs(Number(after.quantity)-round(movements))<0.00001,'Opening stock must match its stock movement ledger.','INVALID_OFFLINE_RECORD');
      }
      if(effect.kind==='customer'){
        for(const field of ['visits','spent','balance','points'])money(after[field],`Customer ${field}`);
        const phone=String(after.phone??'').replace(/[^\d+]/g,'');
        const duplicate=phone&&Object.values(projection.records).some(row=>row.kind==='customer'&&String(row.value.phone??'').replace(/[^\d+]/g,'')===phone);
        if(duplicate){
          if(!input.offline)fail('A customer with this phone number already exists. Select the existing customer.','DUPLICATE_CUSTOMER');
          warn('A customer with the same phone number was added on another offline device. Both customer records and their loan histories were preserved for review.');
        }
      }
      if(effect.kind==='shift'){
        check(after.status==='open'&&after.expectedCash===after.openingFloat,'The offline opening float is invalid.','INVALID_OFFLINE_RECORD');money(after.openingFloat,'Opening float');
        if(Object.values(projection.records).some(row=>row.kind==='shift'&&row.branchId===effect.branchId&&row.value.status==='open')){
          if(!input.offline)fail('A cash shift is already open in this branch.','SHIFT_ALREADY_OPEN');
          warn('Another device also opened a shift while this device was offline. Reconcile both cash drawers at day end.');
        }
      }
      put(effect,after);continue;
    }
    check(current,`The offline ${effect.kind} record no longer exists.`);
    if(effect.kind==='inventory'){
      immutable(before,after,['quantity','updatedAt','minimum','unitCost','supplierId'],'Offline stock transactions cannot change stock units or product links.');
      check(['unit','category','menuItemId'].every(key=>equal(before[key],current![key])),'Stock units or product links changed. Review this pending transaction.');
      const delta=round(quantity(after.quantity)-quantity(before.quantity));
      const movements=input.changes.filter(value=>value.kind==='movement'&&value.after?.itemId===effect.id).reduce((sum,value)=>sum+Number(value.after!.quantity),0);
      check(Math.abs(delta-round(movements))<0.00001,'The stock quantity change does not match its movement ledger.','INVALID_OFFLINE_RECORD');
      const next=round(quantity(current!.quantity)+delta);
      if(!input.offline)check(next>=0,`Insufficient ${String(current!.name??effect.id)}: ${String(current!.quantity)} ${String(current!.unit??'')} available.`,'INSUFFICIENT_STOCK');
      const received=input.changes.filter(value=>value.kind==='purchase').flatMap(value=>(value.after!.lines as Record<string,unknown>[]).filter(line=>line.itemId===effect.id));
      const batches=input.changes.filter(value=>value.kind==='production'&&value.after!.menuItemId===after.menuItemId&&delta>0);
      let updated=mergeFields(effect,current!,['quantity','updatedAt',...(received.length||batches.length?['unitCost','supplierId']:[])]);
      if(received.length||batches.length){
        const incoming=received.length?received.reduce((sum,line)=>sum+Number(line.quantity),0):batches.reduce((sum,value)=>sum+Number(value.after!.quantity),0);
        const cost=received.length?received.reduce((sum,line)=>sum+Number(line.total),0):batches.reduce((sum,value)=>sum+Number(value.after!.cost),0);
        check(incoming>0&&Math.abs(round(incoming)-delta)<0.00001,'Incoming stock does not match its purchase or production ledger.','INVALID_OFFLINE_RECORD');
        const valuedQuantity=Math.max(0,Number(current!.quantity));
        updated={...updated,unitCost:Math.round((valuedQuantity*Number(current!.unitCost)+cost)/(valuedQuantity+incoming))};
        if(received.length)updated.supplierId=after.supplierId;
      }
      put(effect,{...updated,quantity:next,updatedAt:after.updatedAt});
      if(next<0)warn(`${String(current!.name??effect.id)} is below zero after offline sales. Count and adjust actual stock.`);
    }else if(effect.kind==='shift'){
      immutable(before,after,['expectedCash','status','closedAt','countedCash','variance'],'Offline billing cannot change the opening cash float.');
      const delta=money(after.expectedCash,'Expected cash')-money(before.expectedCash,'Previous expected cash');
      const expectedCash=Number(current!.expectedCash)+delta;
      check(Number.isSafeInteger(expectedCash),'The merged drawer balance is invalid.','INVALID_OFFLINE_RECORD');
      if(!input.offline)check(expectedCash>=0,'The cash drawer does not contain enough recorded cash.','INSUFFICIENT_CASH');
      const closes=before.status!==after.status;
      if(closes)check(after.status==='closed','An offline command cannot reopen a closed shift.','INVALID_OFFLINE_RECORD');
      if(closes&&current!.status==='closed'&&!equal(current!.countedCash,after.countedCash))warn('This shift was closed on another device. Both recorded cash counts require review.');
      if(current!.status==='closed'&&delta!==0)warn('Offline cash transactions reached an already closed shift. Its expected cash and variance have been recalculated.');
      if(expectedCash<0)warn('The recorded cash drawer balance is below zero after offline transactions. Reconcile the drawer.');
      const closing=closes&&current!.status!=='closed'?{status:after.status,closedAt:after.closedAt,countedCash:after.countedCash}:{};
      const next:Record<string,unknown>={...current!,...closing,expectedCash};
      if(next.status==='closed')next.variance=Number(next.countedCash)-expectedCash;
      put(effect,next);
    }else if(effect.kind==='customer'){
      immutable(before,after,['visits','spent','points','balance'],'Offline billing cannot change an existing customer profile.');
      const next={...current!};
      for(const field of ['visits','spent','points']){
        const value=money(current![field],`Customer ${field}`)+money(after[field],`Customer ${field}`)-money(before[field],`Previous customer ${field}`);
        check(Number.isSafeInteger(value),'Merged customer counters are invalid.','INVALID_OFFLINE_RECORD');next[field]=Math.max(0,value);
      }
      put(effect,next);
    }else if(effect.kind==='order'){
      if(!input.offline)check(current!.version===before.version,'This order changed on another device. Refresh before trying again.','VERSION_CONFLICT');
      immutable(before,after,orderMutable,'Offline billing cannot reprice or replace an existing bill.');
      immutable(before,current!,orderMutable,'This bill changed before the pending transaction was uploaded.');
      const previous=before.payments as Record<string,unknown>[],payments=after.payments as Record<string,unknown>[],existing=current!.payments as Record<string,unknown>[];
      check(previous.every(value=>payments.some(next=>next.id===value.id&&equal(next,value))),'Offline billing cannot remove or edit earlier payments.','INVALID_OFFLINE_RECORD');
      const additions=payments.filter(value=>!previous.some(old=>old.id===value.id));
      for(const value of additions)check(!existing.some(old=>old.id===value.id),'This payment ID was already used by another transaction.');
      const merged=[...existing,...additions],paid=merged.reduce((sum,value)=>sum+Number(value.amount),0);
      const refunded=Number(current!.refunded)+Number(after.refunded)-Number(before.refunded);
      check(Number.isSafeInteger(paid)&&Number.isSafeInteger(refunded)&&refunded>=0&&refunded<=paid,'The merged payment/refund balance is invalid.','INVALID_OFFLINE_RECORD');
      let status=String(current!.status);
      const progress=['new','preparing','ready','served','completed'];
      if(after.status!==before.status){
        if(after.status==='cancelled'){
          if(paid===refunded)status='cancelled';else warn('An offline cancellation reached a bill with another payment. The payment and bill have been preserved for review.');
        }else if(status==='cancelled')warn('An offline payment or preparation update reached a cancelled bill. Its financial history has been preserved for review.');
        else if(progress.indexOf(String(after.status))>progress.indexOf(status))status=String(after.status);
      }
      const oldCustomer=current!.customerId;
      check(!oldCustomer||!after.customerId||oldCustomer===after.customerId,'This bill was assigned to a different customer on another device.');
      const customerId=oldCustomer??after.customerId;
      const paymentStatus=refunded>0?(refunded===paid?'refunded':'partial'):paid>=Number(current!.total)?'paid':paid>0?'partial':'unpaid';
      if(paid>Number(current!.total))warn('This bill received payments on more than one offline device. All payments were preserved; review the overpayment.');
      put(effect,{...current!,customerId,payments:merged,paid,refunded,paymentStatus,status,updatedAt:after.updatedAt,version:Number(current!.version)+1});
    }else if(effect.kind==='table'){
      immutable(before,after,['status','orderId'],'Offline billing cannot change table setup.');
      if(equal(current,before))put(effect,after);
      else {
        if(!input.offline)fail('This table changed on another device. Select the current table before confirming.','TABLE_CONFLICT');
        warn('A table was used by another device while offline. The existing table assignment was preserved; the sale is still saved.');
      }
    }else if(effect.kind==='held'){
      if(equal(current,before))put(effect,after);
      else if(after.status==='resumed'){
        if(!input.offline)fail('This held bill changed on another device. Reload it before confirming.','HELD_BILL_CONFLICT');
        warn('A held bill changed on another device. Its current version was preserved; the offline sale is saved separately.');
      }
      else fail('This held bill changed on another device. Review the pending offline change.');
    }else fail('This record cannot be updated by offline billing.','OFFLINE_OPERATION_FORBIDDEN');
  }
  // Verify append references only after all new customers/orders have been added.
  for(const effect of input.changes){
    const value=effect.after;if(!value)continue;
    if(effect.kind==='category'){
      const duplicate=Object.values(projection.records).some(row=>row.kind==='category'&&row.id!==effect.id&&String(row.value.name).toLowerCase()===String(value.name).toLowerCase());
      if(duplicate){
        if(!input.offline||effect.before)fail('A category with this name already exists. Review the pending category edit.','DUPLICATE_CATEGORY');
        warn('The same category name was created on two offline devices. Both categories and their products were preserved. Rename one category when convenient.');
      }
    }
    if(effect.kind==='menu'){
      check(get('category',String(value.categoryId)),'The category for this product is unavailable.');
      const others=Object.values(projection.records).filter(row=>row.kind==='menu'&&row.id!==effect.id);
      if(value.barcode)check(!others.some(row=>row.value.barcode===value.barcode),'This barcode was assigned to another product. The pending product remains saved for review.','DUPLICATE_BARCODE');
      if(value.sku)check(!others.some(row=>String(row.value.sku??'').toUpperCase()===String(value.sku).toUpperCase()),'This SKU was assigned to another product. The pending product remains saved for review.','DUPLICATE_SKU');
    }
    if(effect.kind==='recipe'){
      check(get('menu',effect.id),'The product for this recipe is unavailable.');
      for(const line of value.ingredients as Record<string,unknown>[])check(Object.values(projection.records).some(row=>row.kind==='inventory'&&['ingredient','packaging'].includes(String(row.value.category))&&(row.id===line.key||row.id===`${row.branchId}-${String(line.key)}`)),'An offline recipe refers to an unconfigured ingredient.','INVALID_OFFLINE_RECORD');
    }
    if(effect.kind==='inventory'){
      if(value.menuItemId)check(get('menu',String(value.menuItemId)),'The product linked to this stock item is unavailable.');
      if(value.supplierId)check(get('supplier',String(value.supplierId)),'The supplier linked to this stock item is unavailable.');
      if(!effect.before&&value.menuItemId&&['prepared','resale'].includes(String(value.category)))check(!Object.values(projection.records).some(row=>row.kind==='inventory'&&row.id!==effect.id&&row.branchId===effect.branchId&&['prepared','resale'].includes(String(row.value.category))&&row.value.menuItemId===value.menuItemId),'Linked sale stock already exists for this product. Review the pending stock setup.','DUPLICATE_SALE_STOCK');
    }
    if(effect.kind==='supplier'&&!effect.before)check(value.balance===0,'A new supplier must start with zero unpaid purchases.','INVALID_OFFLINE_RECORD');
    if(effect.kind==='purchase'){
      check(get('supplier',String(value.supplierId)),'The supplier for this goods receipt is unavailable.');
      check(input.changes.some(row=>row.kind==='supplier'&&row.id===value.supplierId),'The goods receipt is missing its supplier balance change.','INVALID_OFFLINE_RECORD');
      for(const line of value.lines as Record<string,unknown>[]){
        const stock=get('inventory',String(line.itemId));check(stock?.branchId===effect.branchId,'A goods receipt refers to stock outside this branch.','INVALID_OFFLINE_RECORD');
        const changed=input.changes.find(row=>row.kind==='inventory'&&row.id===line.itemId);
        check(changed?.before&&Math.abs(round(Number(changed.after!.quantity)-Number(changed.before.quantity))-Number(line.quantity))<0.00001,'The goods receipt is missing its incoming stock quantity.','INVALID_OFFLINE_RECORD');
      }
    }
    if(effect.kind==='production'){
      const target=input.changes.find(row=>row.kind==='inventory'&&row.after?.menuItemId===value.menuItemId&&Number(row.after!.quantity)>Number(row.before?.quantity));
      check(target?.before&&round(Number(target.after!.quantity)-Number(target.before.quantity))===value.quantity,'The production batch is missing its prepared stock increase.','INVALID_OFFLINE_RECORD');
      const ingredients=input.changes.filter(row=>row.kind==='inventory'&&row.before&&Number(row.after?.quantity)<Number(row.before.quantity));
      const capturedCost=Math.round(ingredients.reduce((sum,row)=>sum+(Number(row.before!.quantity)-Number(row.after!.quantity))*Number(row.before!.unitCost),0));
      const roundingTolerance=Math.ceil(ingredients.reduce((sum,row)=>sum+Number(row.before!.unitCost)*0.00005,0))+1;
      check(ingredients.length>0&&Math.abs(capturedCost-Number(value.cost))<=roundingTolerance,'The production cost does not match its consumed ingredient costs.','INVALID_OFFLINE_RECORD');
    }
    if(effect.kind==='credit'){
      check(get('customer',String(value.customerId)),'The customer for this loan entry is unavailable.');
      if(value.type==='sale'){
        const order=get('order',String(value.orderId));
        check(order&&order.customerId===value.customerId&&(order.payments as Record<string,unknown>[]).some(payment=>`credit-${payment.id}`===value.id&&payment.method==='credit'&&payment.amount===value.amount),'The Customer Loan entry does not match a payment.','INVALID_OFFLINE_RECORD');
      }
    }
    if(effect.kind==='movement')check(get('inventory',String(value.itemId)),'A stock movement refers to missing stock.');
    if(effect.kind==='order'){
      if(value.customerId)check(get('customer',String(value.customerId)),'The customer for this offline bill is unavailable.');
      for(const payment of value.payments as Record<string,unknown>[])if(payment.method==='credit')check(get('credit',`credit-${payment.id}`),'A Customer Loan payment is missing its credit ledger.','INVALID_OFFLINE_RECORD');
    }
  }
  // The ledger is authoritative. Additive balance snapshots could overwrite a
  // payment collected by another device while this one was disconnected.
  const customerIds=new Set(input.changes.filter(value=>value.kind==='customer').map(value=>value.id));
  for(const effect of input.changes)if(effect.kind==='credit')customerIds.add(String(effect.after!.customerId));
  for(const customerId of customerIds){
    const value=get('customer',customerId);if(!value)continue;
    const balance=Object.values(projection.records).filter(value=>value.kind==='credit'&&value.value.customerId===customerId).reduce((sum,row)=>sum+(row.value.type==='sale'?1:-1)*Number(row.value.amount),0);
    check(Number.isSafeInteger(balance),'The merged Customer Loan ledger is invalid.','INVALID_OFFLINE_RECORD');
    if(balance<0){
      if(!input.offline)fail('Collection exceeds the current outstanding customer balance.','COLLECTION_EXCEEDS_BALANCE');
      warn('A customer paid on more than one disconnected device. All collections are saved; review the customer advance balance.');
    }
    projection.records[recordKey('customer',customerId)]={kind:'customer',id:customerId,branchId:null,value:{...value,balance}};
  }
  if(warnings.length){
    const branchId=input.changes.find(value=>value.branchId)?.branchId??String(projection.metadata.activeBranchId??'b1');
    const auditId=`offline-${createHash('sha256').update(JSON.stringify([input.deviceId,input.transactionId])).digest('hex')}`;
    const audit:CloudChange={kind:'audit',id:auditId,branchId,value:{id:auditId,branchId,action:'offline.reconciliation-review',actor:'POS offline sync',detail:warnings.join(' ')+(conflicts.length?`\nConflicting field values: ${JSON.stringify(conflicts)}`:''),createdAt:new Date().toISOString()}};
    projection.records[recordKey('audit',auditId)]=audit;
  }
  return {ok:true,transactionId:input.transactionId,warnings};
}
