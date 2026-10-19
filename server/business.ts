import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { User, Settings, Shift, Order, Customer, Category, MenuItem, Role, HeldBill, CreditEntry } from '../shared/types';
import { Store, requireThat, now, uid } from './database';
import { permit } from './security';

export type HeldBillRecord=HeldBill;
export type CreditRecord=CreditEntry;
export const receiptDefaults={receiptPaperWidthMm:80,receiptContentWidthMm:72,receiptOffsetMm:0,receiptMarginMm:2,receiptFontSize:10};
export type ReceiptSettings=Settings & typeof receiptDefaults;
const id=z.string().min(1).max(160);
const command=z.string().min(8).max(160);
const money=z.number().int().min(0).max(1_000_000_000);
export const draftSchema=z.object({commandId:command,branchId:id,type:z.enum(['dine-in','takeaway','delivery']),tableId:id.nullish(),customerId:id.nullish(),note:z.string().max(1000).default(''),discount:money.default(0),lines:z.array(z.object({menuItemId:id,quantity:z.number().int().positive().max(1000),note:z.string().max(300).default('')})).min(1).max(100)});
const financial:Role[]=['owner','manager','cashier','accountant'];
const sales:Role[]=['owner','manager','cashier','waiter'];

export const creditBalance=(store:Store,customerId:string,branchId?:string)=>store.list<CreditRecord>('credit',branchId).filter(x=>x.customerId===customerId).reduce((sum,x)=>sum+(x.type==='sale'?x.amount:-x.amount),0);
export function initializeBusiness(store:Store) {
  const existing=JSON.parse(store.meta('settings')!) as Partial<ReceiptSettings>;
  store.setMeta('settings',JSON.stringify({...receiptDefaults,...existing}));
  // Existing credit payments remain valid after upgrading; deterministic IDs make
  // this migration safe to repeat without changing customers' account balances.
  if(!store.meta('creditLedgerMigrated'))store.transaction(()=>{
    for(const order of store.list<Order>('order')) {
      if(!order.customerId)continue;
      for(const payment of order.payments.filter(x=>x.method==='credit'))store.put<CreditRecord>('credit',{id:`credit-${payment.id}`,branchId:order.branchId,customerId:order.customerId,orderId:order.id,type:'sale',amount:payment.amount,method:'credit',reference:payment.reference,note:`Credit sale ${order.number}`,createdAt:payment.createdAt,createdBy:order.createdBy});
    }
    const refunds=store.list<{id:string;branchId:string;orderId:string;method:string;amount:number;reason:string;createdAt:string;createdBy:string}>('refund');
    for(const refund of refunds.filter(x=>x.method==='credit')){const order=store.get<Order>('order',refund.orderId);if(order?.customerId)store.put<CreditRecord>('credit',{id:`credit-${refund.id}`,branchId:refund.branchId,customerId:order.customerId,orderId:order.id,type:'refund',amount:refund.amount,method:'credit',reference:'',note:refund.reason,createdAt:refund.createdAt,createdBy:refund.createdBy});}
    store.setMeta('creditLedgerMigrated',now());
  });
}
export function validateReceiptSettings(settings:ReceiptSettings) {
  requireThat(settings.receiptContentWidthMm+2*settings.receiptMarginMm<=settings.receiptPaperWidthMm,'Receipt content width and margins must fit within the paper width.');
  requireThat(Math.abs(settings.receiptOffsetMm)<=((settings.receiptPaperWidthMm-settings.receiptContentWidthMm)/2-settings.receiptMarginMm),'Receipt offset would move the content outside the printable area.');
}
export function validateMenuCodes(store:Store,data:{barcode?:string;sku?:string},exceptId?:string) {
  const items=store.list<MenuItem & {barcode?:string;sku?:string}>('menu').filter(x=>x.id!==exceptId);
  if(data.barcode)requireThat(!items.some(x=>x.barcode===data.barcode),'This barcode is already assigned to another product.',409,'DUPLICATE_BARCODE');
  if(data.sku)requireThat(!items.some(x=>x.sku?.toUpperCase()===data.sku!.toUpperCase()),'This SKU is already assigned to another product.',409,'DUPLICATE_SKU');
}
interface Context {store:Store;getUser:(request:FastifyRequest)=>User;scoped:(user:User,branchId:string)=>string;audit:(user:User,branchId:string,action:string,detail:string)=>unknown;openShift:(branchId:string)=>Shift|undefined}
const localDate=(timestamp:string)=>new Date(timestamp).toLocaleDateString('en-CA',{timeZone:'Asia/Colombo'});
const csvField=(value:unknown)=>{let text=String(value??'');if(/^[\s]*[=+@\-]/.test(text)&&!/^[-+]?\d+(?:\.\d+)?$/.test(text))text=`'${text}`;return `"${text.replaceAll('"','""')}"`;};

export function registerBusinessRoutes(app:FastifyInstance,context:Context) {
  const {store,getUser,scoped,audit,openShift}=context;
  const validateDraft=(user:User,body:z.infer<typeof draftSchema>)=>{
    scoped(user,body.branchId);if(body.discount)permit(user,['owner','manager']);
    requireThat(body.type==='dine-in'||!body.tableId,'A table can only be assigned to dine-in service.');
    if(body.tableId)requireThat(store.get<{branchId:string}>('table',body.tableId)?.branchId===body.branchId,'Table not found in this branch.',404);
    if(body.customerId)requireThat(store.get('customer',body.customerId),'Customer not found.',404);
    let total=0;for(const line of body.lines){const item=store.get<MenuItem>('menu',line.menuItemId);requireThat(item,'Menu item not found.',404);total+=item.price*line.quantity;}
    requireThat(body.discount<=total,'Discount cannot exceed the subtotal.');
  };
  app.post('/api/held-bills',async request=>{
    const user=getUser(request);permit(user,sales);const body=draftSchema.extend({label:z.string().trim().min(1).max(100).default('Held bill')}).parse(request.body);validateDraft(user,body);
    return store.command(body.commandId,user.id,'bill.held',body.branchId,body,()=>{const heldBill:HeldBillRecord={id:uid('held'),branchId:body.branchId,label:body.label,type:body.type,tableId:body.tableId??null,customerId:body.customerId??null,note:body.note,discount:body.discount,lines:body.lines,status:'held',resumedOrderId:null,createdAt:now(),updatedAt:now(),createdBy:user.id};store.put('held',heldBill);audit(user,body.branchId,'bill.held',body.label);return {ok:true,heldBill};});
  });
  app.put('/api/held-bills/:id', async request => {
    const user = getUser(request);
    permit(user, sales);
    const params = z.object({id}).parse(request.params);
    const body = draftSchema.extend({
      label: z.string().trim().min(1).max(100).default('Held bill'),
      expectedUpdatedAt: z.iso.datetime(),
    }).parse(request.body);
    validateDraft(user, body);
    return store.command(body.commandId, user.id, `bill.update:${params.id}`, body.branchId, body, () => {
      const current = store.get<HeldBillRecord>('held', params.id);
      requireThat(current && current.branchId === body.branchId, 'Held bill not found in this branch.', 404);
      requireThat(current.status === 'held', 'This held bill has already been resumed or discarded.', 409, 'HELD_BILL_CLOSED');
      requireThat(current.updatedAt === body.expectedUpdatedAt, 'This held bill changed on another device. Reload it before saving.', 409, 'HELD_BILL_CONFLICT');
      // Advance even when two edits occur within the same millisecond.
      const updatedAt = new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString();
      const heldBill: HeldBillRecord = {
        ...current,
        label: body.label,
        type: body.type,
        tableId: body.tableId ?? null,
        customerId: body.customerId ?? null,
        note: body.note,
        discount: body.discount,
        lines: body.lines,
        updatedAt,
      };
      store.put('held', heldBill);
      audit(user, body.branchId, 'bill.updated', heldBill.label);
      return {ok: true, heldBill};
    });
  });
  app.delete('/api/held-bills/:id',async request=>{
    const user=getUser(request);permit(user,sales);const params=z.object({id}).parse(request.params);const body=z.object({commandId:command}).parse(request.body);const held=store.get<HeldBillRecord>('held',params.id);requireThat(held,'Held bill not found.',404);scoped(user,held.branchId);
    return store.command(body.commandId,user.id,`bill.discard:${held.id}`,held.branchId,body,()=>{const current=store.get<HeldBillRecord>('held',held.id)!;requireThat(current.status==='held','This held bill has already been resumed or discarded.',409,'HELD_BILL_CLOSED');store.put('held',{...current,status:'discarded' as const,updatedAt:now()});audit(user,held.branchId,'bill.discarded',held.label);return {ok:true};});
  });
  const categorySchema=z.object({commandId:command,name:z.string().trim().min(2).max(80),icon:z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/).default('utensils')});
  app.post('/api/categories',async request=>{
    const user=getUser(request);permit(user,['owner','manager']);const body=categorySchema.parse(request.body);const branchId=user.branchId??'b1';
    return store.command(body.commandId,user.id,'category.create',branchId,body,()=>{requireThat(!store.list<Category>('category').some(x=>x.name.toLowerCase()===body.name.toLowerCase()),'A category with this name already exists.',409,'DUPLICATE_CATEGORY');const category:Category={id:uid('category'),name:body.name,nameSi:body.name,icon:body.icon};store.put('category',category);audit(user,branchId,'category.created',category.name);return {ok:true,category};});
  });
  app.patch('/api/categories/:id',async request=>{
    const user=getUser(request);permit(user,['owner','manager']);const params=z.object({id}).parse(request.params);const body=categorySchema.parse(request.body);const branchId=user.branchId??'b1';
    return store.command(body.commandId,user.id,`category.update:${params.id}`,branchId,body,()=>{const category=store.get<Category>('category',params.id);requireThat(category,'Category not found.',404);requireThat(!store.list<Category>('category').some(x=>x.id!==category.id&&x.name.toLowerCase()===body.name.toLowerCase()),'A category with this name already exists.',409,'DUPLICATE_CATEGORY');const updated={...category,name:body.name,nameSi:body.name,icon:body.icon};store.put('category',updated);audit(user,branchId,'category.updated',updated.name);return {ok:true,category:updated};});
  });
  app.delete('/api/categories/:id',async request=>{
    const user=getUser(request);permit(user,['owner','manager']);const params=z.object({id}).parse(request.params);const body=z.object({commandId:command}).parse(request.body);const branchId=user.branchId??'b1';
    return store.command(body.commandId,user.id,`category.delete:${params.id}`,branchId,body,()=>{const category=store.get<Category>('category',params.id);requireThat(category,'Category not found.',404);requireThat(!store.list<MenuItem>('menu').some(x=>x.categoryId===category.id),'Move or remove this category’s products before deleting it.',409,'CATEGORY_IN_USE');store.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('category',category.id);store.changes?.push({kind:'category',id:category.id,branchId:null,value:{id:category.id,deleted:true}});audit(user,branchId,'category.deleted',category.name);return {ok:true};});
  });
  app.post('/api/customers/:id/collections',async request=>{
    const user=getUser(request);permit(user,financial);const params=z.object({id}).parse(request.params);const body=z.object({commandId:command,branchId:id,amount:money.refine(x=>x>0,'Amount must be positive.'),method:z.enum(['cash','card','qr']),reference:z.string().max(200).default(''),note:z.string().max(500).default('')}).parse(request.body);scoped(user,body.branchId);
    return store.command(body.commandId,user.id,`credit.collect:${params.id}`,body.branchId,body,()=>{
      const customer=store.get<Customer>('customer',params.id);requireThat(customer,'Customer not found.',404);const balance=creditBalance(store,customer.id,body.branchId);requireThat(body.amount<=balance,'Collection exceeds this customer’s outstanding balance in this branch.',409,'COLLECTION_EXCEEDS_BALANCE');
      if(body.method==='cash'){const shift=openShift(body.branchId);requireThat(shift,'Open a cash shift before collecting cash.',409,'SHIFT_REQUIRED');store.put('shift',{...shift,expectedCash:shift.expectedCash+body.amount});}
      const entry:CreditRecord={id:uid('credit'),branchId:body.branchId,customerId:customer.id,orderId:null,type:'collection',amount:body.amount,method:body.method,reference:body.reference,note:body.note,createdAt:now(),createdBy:user.id};store.put('credit',entry);store.put('customer',{...customer,balance:creditBalance(store,customer.id)});audit(user,body.branchId,'credit.collected',`${customer.name} · ${body.amount} · ${body.method}`);return {ok:true,entry,balance:balance-body.amount};
    });
  });
  app.get('/api/reports/income-expenses',async(request,reply)=>{
    const user=getUser(request);permit(user,financial);const date=z.iso.date();const query=z.object({branchId:id.optional(),from:date,to:date,format:z.enum(['csv','json']).default('csv')}).parse(request.query);const branchId=scoped(user,query.branchId??user.branchId??'b1');requireThat(query.from<=query.to,'The start date must be before the end date.');
    type Row={date:string;timestamp:string;type:string;reference:string;description:string;method:string;income:number;expense:number};const rows:Row[]=[];
    const inRange=(timestamp:string)=>{const date=localDate(timestamp);return date>=query.from&&date<=query.to;};
    for(const order of store.list<Order>('order',branchId))for(const payment of order.payments)if(payment.method!=='credit'&&inRange(payment.createdAt))rows.push({date:localDate(payment.createdAt),timestamp:payment.createdAt,type:'sale',reference:order.number,description:`Sale ${order.number}`,method:payment.method,income:payment.amount,expense:0});
    for(const entry of store.list<CreditRecord>('credit',branchId))if(entry.type==='collection'&&inRange(entry.createdAt))rows.push({date:localDate(entry.createdAt),timestamp:entry.createdAt,type:'collection',reference:entry.reference||entry.id,description:entry.note||`Customer collection: ${store.get<Customer>('customer',entry.customerId)?.name??entry.customerId}`,method:entry.method,income:entry.amount,expense:0});
    for(const refund of store.list<{id:string;orderId:string;method:string;amount:number;reason:string;createdAt:string}>('refund',branchId))if(refund.method!=='credit'&&inRange(refund.createdAt))rows.push({date:localDate(refund.createdAt),timestamp:refund.createdAt,type:'refund',reference:store.get<Order>('order',refund.orderId)?.number??refund.id,description:refund.reason,method:refund.method,income:0,expense:refund.amount});
    for(const expense of store.list<{id:string;description:string;paymentMethod:string;amount:number;createdAt:string}>('expense',branchId))if(inRange(expense.createdAt))rows.push({date:localDate(expense.createdAt),timestamp:expense.createdAt,type:'expense',reference:expense.id,description:expense.description,method:expense.paymentMethod,income:0,expense:expense.amount});
    rows.sort((a,b)=>a.timestamp.localeCompare(b.timestamp));const income=rows.reduce((sum,x)=>sum+x.income,0),expense=rows.reduce((sum,x)=>sum+x.expense,0);
    if(query.format==='json')return {branchId,from:query.from,to:query.to,currency:'LKR',basis:'cashflow',income,expense,net:income-expense,rows};
    reply.header('Content-Type','text/csv; charset=utf-8').header('Content-Disposition',`attachment; filename="income-expenses-${branchId}-${query.from}-${query.to}.csv"`);
    const header=['Date (Asia/Colombo)','Type','Reference','Description','Method','Income (LKR)','Expense (LKR)','Net (LKR)'];
    const format=(n:number)=>(n/100).toFixed(2);return '\ufeff'+[header,...rows.map(x=>[x.date,x.type,x.reference,x.description,x.method,format(x.income),format(x.expense),format(x.income-x.expense)]),['TOTAL','','','','',format(income),format(expense),format(income-expense)]].map(line=>line.map(csvField).join(',')).join('\r\n');
  });
}
