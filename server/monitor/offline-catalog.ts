import {z} from 'zod';
import {isProductImageReference} from '../../shared/media.js';
import type {OfflineCloudEffect} from '../../shared/offline-cloud.js';

const id=z.string().min(1).max(160),money=z.number().int().min(0).max(1_000_000_000),positive=z.number().finite().positive().max(100000),stock=z.number().finite().min(0).max(100000);
const category=z.object({id,name:z.string().trim().min(2).max(80),nameSi:z.string().max(160),icon:z.string().min(1).max(40)}).strict();
const menu=z.object({
  id,name:z.string().trim().min(2).max(120),nameSi:z.string().max(160),description:z.string().max(500),categoryId:id,
  price:money.refine(value=>value>0),cost:money,image:z.string().max(500).refine(isProductImageReference),available:z.boolean(),stockMode:z.enum(['prepared','recipe','untracked']),
  badge:z.string().max(30).optional(),preparationMinutes:z.number().int().min(0).max(180),barcode:z.string().max(80).optional(),sku:z.string().max(80).optional(),reorderLevel:stock.optional(),
}).strict();
const inventory=z.object({id,branchId:id,name:z.string().min(1).max(120),nameSi:z.string().max(160),category:z.enum(['ingredient','prepared','packaging','resale']),unit:z.string().min(1).max(30),quantity:z.number().finite().min(-1e12).max(1e12),minimum:stock,unitCost:money,supplierId:id.nullable(),menuItemId:id.nullable(),updatedAt:z.iso.datetime()}).strict();
const recipe=z.object({id,batchYield:z.number().finite().min(1).max(100000).optional(),ingredients:z.array(z.object({key:id,quantity:positive}).strict()).min(1).max(50)}).strict();
const supplier=z.object({id,name:z.string().trim().min(2).max(120),phone:z.string().min(5).max(30),email:z.union([z.email(),z.literal('')]),balance:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict();
const settings=z.object({businessName:z.string().trim().min(2).max(100),tagline:z.string().max(150),currency:z.literal('LKR'),taxRate:z.number().finite().min(0).max(100),serviceChargeRate:z.number().finite().min(0).max(100),receiptFooter:z.string().max(500),lowStockAlerts:z.boolean(),autoPrint:z.boolean(),language:z.enum(['en','si']),receiptPaperWidthMm:z.number().finite().min(40).max(120),receiptContentWidthMm:z.number().finite().min(20).max(120),receiptMarginMm:z.number().finite().min(0).max(15),receiptOffsetMm:z.number().finite().min(-30).max(30),receiptFontSize:z.number().finite().min(6).max(18)}).strict();
const purchase=z.object({id,branchId:id,supplierId:id,supplierName:z.string().min(1).max(120),invoiceNumber:z.string().trim().min(1).max(100),total:money,status:z.literal('received'),createdAt:z.iso.datetime(),lines:z.array(z.object({itemId:id,name:z.string().min(1).max(120),quantity:positive,unitCost:money,total:money}).strict()).min(1).max(100)}).strict();
const production=z.object({id,branchId:id,menuItemId:id,name:z.string().min(1).max(120),quantity:z.number().int().positive().max(10000),cost:money,note:z.string().max(500),createdAt:z.iso.datetime(),createdBy:id}).strict();

export const catalogKinds=new Set(['category','menu','recipe','settings','supplier']);
const fail=(message:string,code='OFFLINE_RECONCILIATION_CONFLICT'):never=>{throw Object.assign(new Error(message),{status:409,code});};
const stable=(value:unknown):string=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(stable).join(',')}]`:`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable((value as Record<string,unknown>)[key])}`).join(',')}}`;
export const sameCatalogValue=(a:unknown,b:unknown)=>stable(a)===stable(b);

/** Only changed scalar fields are merged; a stale edit never replaces an entire row. */
export function mergeCatalogFields(kind:string,before:Record<string,unknown>,after:Record<string,unknown>,current:Record<string,unknown>,excluded:string[]=[],resolveConflict?:(field:string)=>boolean):Record<string,unknown> {
  const next={...current};
  for(const field of new Set([...Object.keys(before),...Object.keys(after)])){
    if(excluded.includes(field)||sameCatalogValue(before[field],after[field]))continue;
    if(!sameCatalogValue(current[field],before[field])&&!sameCatalogValue(current[field],after[field])){
      if(!resolveConflict)fail(`The ${kind} ${field} changed on another device. This offline edit is still saved; review it before syncing again.`,'OFFLINE_CATALOG_CONFLICT');
      if(!resolveConflict!(field))continue;
    }
    if(Object.hasOwn(after,field))next[field]=after[field];else delete next[field];
  }
  return next;
}

export function validateCatalogRecord(kind:string,value:Record<string,unknown>):void {
  const schema=({category,menu,inventory,recipe,supplier,settings,purchase,production} as Record<string,z.ZodType>)[kind];
  if(!schema)return;
  const parsed=schema.safeParse(value);
  if(!parsed.success)fail(`Invalid offline ${kind}: ${parsed.error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`).join('; ')}`,'INVALID_OFFLINE_RECORD');
  if(kind==='recipe'){
    const lines=value.ingredients as {key:string}[];
    if(new Set(lines.map(line=>line.key)).size!==lines.length)fail('An offline recipe contains duplicate ingredients.','INVALID_OFFLINE_RECORD');
  }
  if(kind==='settings'){
    const v=value as Record<string,number>;
    if(v.receiptContentWidthMm+2*v.receiptMarginMm>v.receiptPaperWidthMm||Math.abs(v.receiptOffsetMm)>(v.receiptPaperWidthMm-v.receiptContentWidthMm)/2-v.receiptMarginMm)fail('The receipt settings move content outside the printable paper width.','INVALID_OFFLINE_RECORD');
  }
  if(kind==='purchase'){
    const lines=value.lines as {itemId:string;quantity:number;unitCost:number;total:number}[];
    if(new Set(lines.map(line=>line.itemId)).size!==lines.length||lines.some(line=>line.total!==Math.round(line.quantity*line.unitCost))||value.total!==lines.reduce((sum,line)=>sum+line.total,0))fail('The offline purchase costs do not balance.','INVALID_OFFLINE_RECORD');
  }
}

export function validateMovement(effect:OfflineCloudEffect,path:string):void {
  const value=effect.after!;
  if(!Number.isFinite(value.quantity)||Number(value.quantity)===0||typeof value.itemId!=='string')fail('The offline stock movement is invalid.','INVALID_OFFLINE_RECORD');
  const expected=path==='/orders'?'sale':path==='/inventory'?'opening':path==='/inventory/wastage'?'waste':path==='/production'?'production':path==='/purchases'?'purchase':'adjustment';
  if(value.type!==expected)fail('The stock movement does not match this operation.','INVALID_OFFLINE_RECORD');
  if(['sale','waste'].includes(expected)&&Number(value.quantity)>=0||['opening','purchase'].includes(expected)&&Number(value.quantity)<=0)fail('The offline stock movement has an invalid direction.','INVALID_OFFLINE_RECORD');
  if(expected==='waste'&&(!Number.isSafeInteger(value.unitCost)||Number(value.unitCost)<0||!Number.isSafeInteger(value.totalCost)||Number(value.totalCost)<0||Math.abs(Number(value.totalCost)-Math.round(Math.abs(Number(value.quantity))*Number(value.unitCost)))>Math.ceil(Number(value.unitCost)*0.00005)+1))fail('The recorded wastage cost is invalid.','INVALID_OFFLINE_RECORD');
}
