import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { z, ZodError } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { User, Role, StaffMember, Branch, MenuItem, Order, InventoryItem, StockMovement, DiningTable, Customer, Settings, Shift, Supplier, Snapshot, SyncState, ProductionBatch, Purchase, Expense, AuditEvent, Category, Recipe } from '../shared/types';
import { Store, ApiError, requireThat, now, uid, sha } from './database';
import { initialize } from './seed';
import { authenticate, branchScope, permit, sessionUser, asUser, setPin, verifyPin } from './security';

const command = z.string().min(8).max(160);
const id = z.string().min(1).max(160);
const money = z.number().int().min(0).max(1_000_000_000);
const amount = money.refine(x=>x>0,'Amount must be greater than zero.');
const quantity = z.number().positive().max(100000).refine(x=>Number.isFinite(x));
const roleSchema = z.enum(['owner','manager','cashier','waiter','kitchen','storekeeper','accountant']);
const method = z.enum(['cash','card','qr','credit']);
const sales: Role[] = ['owner','manager','cashier','waiter'];
const finance: Role[] = ['owner','manager','cashier','accountant'];
const management: Role[] = ['owner','manager'];
const stores: Role[] = ['owner','manager','storekeeper'];
const productionRoles: Role[] = ['owner','manager','kitchen','storekeeper'];
const roundQty = (x: number) => Math.round(x*10000)/10000;
const html = (x: unknown) => String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
interface AppOptions { databasePath?: string; seed?: boolean; logger?: boolean }

export async function createApp(options: AppOptions = {}) {
  const app = Fastify({logger: options.logger ?? false, bodyLimit: 256 * 1024, trustProxy: false});
  const store = new Store(options.databasePath ?? process.env.DATABASE_PATH ?? 'data/demo-hotel.sqlite');
  const demo = options.seed ?? (process.env.POS_DEMO_MODE !== 'false' && process.env.NODE_ENV !== 'production');
  try { initialize(store,demo); } catch(error) { store.close();throw error; }
  try{if(process.env.SYNC_ENDPOINT&&process.env.SYNC_TOKEN)store.queueBaseline(process.env.HUB_BRANCH_ID??'b1',process.env.HUB_ID??'local-hub',process.env.SYNC_ENDPOINT);}catch(error){store.close();throw error;}
  await app.register(cookie);
  app.decorate('store',store);
  let syncing = false;
  let syncFinished:Promise<void>=Promise.resolve();let finishSync:()=>void=()=>{};
  const attempts = new Map<string,{failures:number;until:number}>();
  const getUser = (request: FastifyRequest) => authenticate(store,request);
  const scoped = (user:User,branchId:string) => branchScope(store,user,branchId);
  const audit = (user:User,branchId:string,action:string,detail:string) => store.put<AuditEvent>('audit',{id:uid('audit'),branchId,action,actor:user.name,detail,createdAt:now()});
  const settings = () => JSON.parse(store.meta('settings')!) as Settings;
  const openShift = (branchId:string) => store.list<Shift>('shift',branchId).find(x=>x.status==='open');
  const publicOrder = (user:User,order:Order):Order => user.role==='kitchen'?{...order,customerId:null,subtotal:0,discount:0,tax:0,serviceCharge:0,total:0,paid:0,refunded:0,payments:[],lines:order.lines.map(line=>({...line,unitPrice:0,lineTotal:0}))}:user.role==='waiter'?{...order,payments:[]}:order;
  const ingredientStock = (branchId:string,key:string) => {
    const candidate=store.get<InventoryItem>('inventory',`${branchId}-${key}`)??store.get<InventoryItem>('inventory',key);
    return candidate?.branchId===branchId?candidate:undefined;
  };
  const getOrder = (user:User,orderId:string) => {
    const order=store.get<Order>('order',orderId);requireThat(order,'Order not found.',404);scoped(user,order.branchId);return order;
  };
  const versionCheck = (order:Order,expected:number) => requireThat(order.version===expected,'This order changed on another device. Refresh before trying again.',409,'VERSION_CONFLICT');
  const moveStock = (user:User,item:InventoryItem,delta:number,type:string,reason:string) => {
    const next=roundQty(item.quantity+delta);requireThat(next>=0,`Insufficient ${item.name}: ${item.quantity} ${item.unit} available.`,409,'INSUFFICIENT_STOCK');
    store.put('inventory',{...item,quantity:next,updatedAt:now()});
    store.put<StockMovement>('movement',{id:uid('stock'),itemId:item.id,branchId:item.branchId,type,quantity:roundQty(delta),reason,createdAt:now(),createdBy:user.id});
  };
  const consume = (user:User,branchId:string,item:MenuItem,count:number,reason:string,production=false) => {
    if(!production && item.stockMode==='untracked') return;
    if(!production && item.stockMode==='prepared') {
      const stock=store.list<InventoryItem>('inventory',branchId).find(x=>x.menuItemId===item.id && x.category==='prepared');
      requireThat(stock,`No prepared stock is configured for ${item.name}.`,409);moveStock(user,stock,-count,'sale',reason);return;
    }
    const recipe=store.get<Recipe>('recipe',item.id);requireThat(recipe,`No recipe is configured for ${item.name}.`,409,'RECIPE_REQUIRED');
    for(const ingredient of recipe.ingredients) {
      const stock=ingredientStock(branchId,ingredient.key);requireThat(stock,'Recipe ingredient is missing in this branch.',409);moveStock(user,stock,-ingredient.quantity*count,production?'production':'sale',reason);
    }
  };
  const releaseTable = (order:Order) => { if(order.tableId) { const table=store.get<DiningTable>('table',order.tableId);if(table?.orderId===order.id) store.put('table',{...table,status:'available' as const,orderId:undefined}); } };
  const menuAvailable = (item:MenuItem,branchId:string) => {
    if(!item.available)return false;
    if(item.stockMode==='untracked')return true;
    if(item.stockMode==='prepared')return store.list<InventoryItem>('inventory',branchId).some(x=>x.menuItemId===item.id&&x.category==='prepared'&&x.quantity>=1);
    const recipe=store.get<Recipe>('recipe',item.id);
    return Boolean(recipe?.ingredients.length&&recipe.ingredients.every(line=>(ingredientStock(branchId,line.key)?.quantity??0)>=line.quantity));
  };
  const syncState = (branchId?:string): SyncState => {
    const filter=branchId?' WHERE branch_id=?':'';
    const rows=store.db.prepare(`SELECT status,COUNT(*) AS count FROM outbox${filter} GROUP BY status`).all(...(branchId?[branchId]:[])) as {status:string;count:number}[];
    const count=(status:string)=>Number(rows.find(x=>x.status===status)?.count??0);
    return {configured:Boolean(process.env.SYNC_ENDPOINT&&process.env.SYNC_TOKEN),pending:count('pending')+count('failed'),synced:count('synced'),failed:count('failed'),lastSync:store.meta('lastSync')??null,lastError:store.meta('lastSyncError')||null,lastBackup:store.meta('lastBackup')??null,hubOnline:true};
  };
  async function sync(force=false) {
    if(syncing) return;
    if(!process.env.SYNC_ENDPOINT||!process.env.SYNC_TOKEN) return;
    const endpoint=new URL(process.env.SYNC_ENDPOINT);
    requireThat(endpoint.protocol==='https:' || (endpoint.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)),'Cloud sync requires HTTPS.',500);
    syncing=true;
    syncFinished=new Promise<void>(resolve=>{finishSync=resolve;});
    try {
      const candidates=store.db.prepare(`SELECT id,payload,attempts FROM outbox WHERE branch_id=? AND status!='synced' AND (? OR next_attempt<=?) ORDER BY rowid LIMIT 50`).all(process.env.HUB_BRANCH_ID??'b1',force?1:0,Date.now()) as {id:string;payload:string;attempts:number}[];
      const rows:typeof candidates=[];let bytes=0;
      for(const row of candidates){const size=Buffer.byteLength(row.payload);if(rows.length&&bytes+size>6*1024*1024)break;rows.push(row);bytes+=size;}
      if(!rows.length) return;
      try {
        const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${process.env.SYNC_TOKEN}`},body:JSON.stringify({hubId:process.env.HUB_ID??'local-hub',events:rows.map(x=>JSON.parse(x.payload))}),signal:AbortSignal.timeout(12000),redirect:'error'});
        requireThat(response.ok,`Sync server responded ${response.status}.`,502);
        const result=z.object({acceptedIds:z.array(z.string())}).parse(await response.json());
        const accepted=new Set(result.acceptedIds);
        store.transaction(()=>{
          for(const row of rows) {
            if(accepted.has(row.id)) store.db.prepare("UPDATE outbox SET status='synced',synced_at=?,last_error=NULL WHERE id=?").run(now(),row.id);
            else store.db.prepare("UPDATE outbox SET status='failed',attempts=attempts+1,next_attempt=?,last_error=? WHERE id=?").run(Date.now()+60000,'Server did not acknowledge this event.',row.id);
          }
          if(rows.some(x=>accepted.has(x.id)))store.setMeta('lastSync',now());
          store.setMeta('lastSyncError',rows.every(x=>accepted.has(x.id))?'':'Some events were not acknowledged.');
        });
      } catch(error) {
        const message=error instanceof Error?error.message:'Cloud sync failed.';
        store.transaction(()=>{for(const row of rows) store.db.prepare("UPDATE outbox SET status='failed',attempts=attempts+1,next_attempt=?,last_error=? WHERE id=?").run(Date.now()+Math.min(3600000,15000*2**Math.min(row.attempts,8)),message.slice(0,500),row.id);store.setMeta('lastSyncError',message.slice(0,500));});
      }
    } finally { syncing=false;finishSync(); }
  }
  const timer=setInterval(()=>{void sync().catch(error=>app.log.error(error));},30000);timer.unref();
  app.addHook('onClose',async()=>{clearInterval(timer);await syncFinished;store.close();});
  app.addHook('onRequest',async(request,reply)=>{
    reply.header('X-Content-Type-Options','nosniff').header('X-Frame-Options','DENY').header('Referrer-Policy','same-origin');
    if(request.url.startsWith('/api/'))reply.header('Cache-Control','no-store');
    if(['POST','PATCH','PUT','DELETE'].includes(request.method)&&request.headers.origin) {
      let same=false;
      try { const origin=new URL(request.headers.origin); const host=new URL(`${request.protocol}://${request.headers.host}`);same=origin.origin===host.origin || (process.env.ALLOWED_ORIGINS??'').split(',').includes(origin.origin); } catch { /* rejected below */ }
      requireThat(same,'Requests from this origin are not allowed.',403,'ORIGIN_FORBIDDEN');
    }
  });
  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof ZodError) return reply.code(400).send({error:error.issues.map(x=>`${x.path.join('.')||'request'}: ${x.message}`).join('; '),code:'VALIDATION_ERROR'});
    if(error instanceof ApiError) return reply.code(error.statusCode).send({error:error.message,code:error.code});
    const httpError=error as {statusCode?:number;message?:string};
    const status=typeof httpError.statusCode==='number'&&httpError.statusCode<500?httpError.statusCode:500;
    if(status===500)request.log.error(error);
    return reply.code(status).send({error:status===500?'The operation could not be saved. Please try again.':httpError.message??'Invalid request.',code:status===500?'INTERNAL_ERROR':'INVALID_REQUEST'});
  });
  app.get('/api/health',async()=>({ok:true,service:'demo-hotel-branch-hub',database:'sqlite',time:now()}));
  app.get('/api/session',async request=>({user:sessionUser(store,request)??null,demo:store.meta('demo')==='true'}));
  app.post('/api/login',async(request,reply)=>{
    const body=z.object({pin:z.string().regex(/^\d{4,12}$/),staffId:id.optional()}).parse(request.body);
    const key=request.ip;const attempt=attempts.get(key);
    requireThat(!attempt||attempt.until<=Date.now()||attempt.failures<10,'Too many unsuccessful sign-in attempts. Try again in 15 minutes.',429,'RATE_LIMITED');
    const rows=store.db.prepare('SELECT staff_id,salt,hash FROM credentials').all() as {staff_id:string;salt:string;hash:string}[];
    let found:StaffMember|undefined;
    for(const row of rows) {
      if(body.staffId&&body.staffId!==row.staff_id)continue;
      const verified=verifyPin(body.pin,row.salt,row.hash);
      const staff=store.get<StaffMember>('staff',row.staff_id);
      if(verified&&staff?.active)found=staff;
    }
    if(!found) {const active=attempt&&attempt.until>Date.now()?attempt:{failures:0,until:Date.now()+15*60000};active.failures++;attempts.set(key,active);throw new ApiError(401,'The PIN is incorrect or this account is inactive.','INVALID_CREDENTIALS');}
    attempts.delete(key);
    const token=randomBytes(32).toString('hex');store.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    store.db.prepare('INSERT INTO sessions(token_hash,staff_id,expires_at) VALUES(?,?,?)').run(sha(token),found.id,Date.now()+12*3600000);
    store.put('staff',{...found,lastActive:now()});
    reply.setCookie('demo_hotel_session',token,{httpOnly:true,sameSite:'strict',secure:process.env.COOKIE_SECURE==='true',path:'/',maxAge:12*3600});
    return {user:asUser(found)};
  });
  app.post('/api/logout',async(request,reply)=>{if(request.cookies.demo_hotel_session)store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(request.cookies.demo_hotel_session));reply.clearCookie('demo_hotel_session',{path:'/'});return {ok:true};});
  app.get('/api/bootstrap',async request=>{
    const user=getUser(request);const query=z.object({branchId:id.optional()}).parse(request.query);const branchId=scoped(user,query.branchId??user.branchId??'b1');
    const isFinance=finance.includes(user.role);const isManagement=management.includes(user.role);const isStore=stores.includes(user.role)||productionRoles.includes(user.role)||user.role==='accountant';
    const maySeeCosts=isManagement||['storekeeper','accountant'].includes(user.role);
    const snapshot:Snapshot={user,branches:store.list<Branch>('branch').filter(x=>user.role==='owner'||x.id===user.branchId),branch:store.get<Branch>('branch',branchId)!,categories:store.list<Category>('category'),menu:store.list<MenuItem>('menu').map(x=>maySeeCosts?x:{...x,cost:0}),recipes:isStore?store.list<Recipe>('recipe'):[],tables:store.list<DiningTable>('table',branchId),orders:sales.includes(user.role)||user.role==='kitchen'||isFinance?store.list<Order>('order',branchId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)):[],inventory:isStore?store.list<InventoryItem>('inventory',branchId).map(x=>maySeeCosts?x:{...x,unitCost:0}):[],stockMovements:isStore?store.list<StockMovement>('movement',branchId).slice(-500).reverse():[],production:productionRoles.includes(user.role)?store.list<ProductionBatch>('production',branchId).reverse().map(x=>maySeeCosts?x:{...x,cost:0}):[],suppliers:stores.includes(user.role)||user.role==='accountant'?store.list<Supplier>('supplier'):[],purchases:stores.includes(user.role)||user.role==='accountant'?store.list<Purchase>('purchase',branchId).reverse():[],customers:sales.includes(user.role)||isFinance?store.list<Customer>('customer'):[],staff:isManagement?store.list<StaffMember>('staff').filter(x=>user.role==='owner'||x.branchId===branchId):[],expenses:isFinance?store.list<Expense>('expense',branchId).reverse():[],shifts:isFinance?store.list<Shift>('shift',branchId).reverse():[],audit:isManagement?store.list<AuditEvent>('audit',branchId).slice(-300).reverse():[],sync:syncState(user.role==='owner'?undefined:branchId),settings:settings(),serverTime:now()};
    // The register sees live sellability even when its role cannot inspect costs or stores.
    snapshot.menu=snapshot.menu.map(item=>({...item,enabled:item.available,available:menuAvailable(item,branchId)}));
    if(user.role==='accountant')snapshot.production=store.list<ProductionBatch>('production',branchId).reverse();
    snapshot.orders=snapshot.orders.map(order=>publicOrder(user,order));
    if(user.role==='waiter')snapshot.customers=snapshot.customers.map(customer=>({...customer,spent:0,balance:0,points:0}));
    if(user.role!=='owner')snapshot.suppliers=snapshot.suppliers.map(supplier=>({...supplier,balance:store.list<Purchase>('purchase',branchId).filter(x=>x.supplierId===supplier.id).reduce((sum,x)=>sum+x.total,0)}));
    return snapshot;
  });
  app.post('/api/orders',async request=>{
    const user=getUser(request);permit(user,sales);
    const body=z.object({commandId:command,branchId:id,type:z.enum(['dine-in','takeaway','delivery']),tableId:id.nullish(),customerId:id.nullish(),note:z.string().max(1000).optional(),discount:money.default(0),lines:z.array(z.object({menuItemId:id,quantity:z.number().int().positive().max(1000),note:z.string().max(300).default('')})).min(1).max(100)}).parse(request.body);
    scoped(user,body.branchId);if(body.discount>0)permit(user,management);
    return store.command(body.commandId,user.id,'order.create',body.branchId,body,()=>{
      requireThat(body.type==='dine-in'||!body.tableId,'A table can only be assigned to a dine-in order.');
      if(body.tableId){const table=store.get<DiningTable>('table',body.tableId);requireThat(table&&table.branchId===body.branchId,'Table not found in this branch.',404);requireThat(table.status==='available','This table already has an active order.',409,'TABLE_OCCUPIED');}
      if(body.customerId)requireThat(store.get('customer',body.customerId),'Customer not found.',404);
      const orderId=uid('order');const branch=store.get<Branch>('branch',body.branchId)!;
      const businessDate=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Colombo'});
      const counterKey=`receipt:${body.branchId}:${businessDate}`;const seq=Number(store.meta(counterKey)??0)+1;store.setMeta(counterKey,String(seq));
      const number=`${branch.code}-${businessDate.replaceAll('-','')}-${String(seq).padStart(4,'0')}`;
      const lines=body.lines.map(x=>{
        const item=store.get<MenuItem>('menu',x.menuItemId);requireThat(item&&item.available,'A selected menu item is unavailable.',409,'ITEM_UNAVAILABLE');consume(user,body.branchId,item,x.quantity,number);
        return {id:uid('line'),menuItemId:item.id,name:item.name,nameSi:item.nameSi,quantity:x.quantity,unitPrice:item.price,lineTotal:item.price*x.quantity,note:x.note};
      });
      const subtotal=lines.reduce((sum,x)=>sum+x.lineTotal,0);requireThat(body.discount<=subtotal,'Discount cannot exceed the subtotal.');
      const cfg=settings();const taxable=subtotal-body.discount;const serviceCharge=body.type==='dine-in'?Math.round(taxable*cfg.serviceChargeRate/100):0;const tax=Math.round((taxable+serviceCharge)*cfg.taxRate/100);
      const order:Order={id:orderId,number,branchId:body.branchId,type:body.type,tableId:body.tableId??null,customerId:body.customerId??null,status:'new',paymentStatus:'unpaid',subtotal,discount:body.discount,tax,serviceCharge,total:taxable+serviceCharge+tax,paid:0,refunded:0,note:body.note??'',createdAt:now(),updatedAt:now(),createdBy:user.id,version:1,lines,payments:[]};
      requireThat(Number.isSafeInteger(order.total)&&order.total<=1_000_000_000,'Order total exceeds the allowed limit.');
      store.put('order',order);
      if(body.tableId){const table=store.get<DiningTable>('table',body.tableId)!;store.put('table',{...table,status:'occupied' as const,orderId});}
      audit(user,body.branchId,'order.created',`${number} · ${lines.length} items`);return {ok:true,order};
    });
  });
  app.patch('/api/orders/:id/status',async request=>{
    const user=getUser(request);permit(user,['owner','manager','cashier','waiter','kitchen']);const params=z.object({id}).parse(request.params);
    const body=z.object({commandId:command,expectedVersion:z.number().int().positive(),status:z.enum(['new','preparing','ready','served','completed','cancelled']),reason:z.string().trim().max(500).optional()}).parse(request.body);
    const existing=getOrder(user,params.id);
    return store.command(body.commandId,user.id,`order.status:${params.id}`,existing.branchId,body,()=>{
      const order=getOrder(user,params.id);versionCheck(order,body.expectedVersion);
      const transitions:Record<Order['status'],Order['status'][]>= {new:['preparing','cancelled'],preparing:['ready','cancelled'],ready:['served','completed','cancelled'],served:['completed','cancelled'],completed:[],cancelled:[]};
      requireThat(transitions[order.status].includes(body.status),'This order status transition is not allowed.',409,'INVALID_TRANSITION');
      if(user.role==='kitchen')requireThat(['preparing','ready'].includes(body.status),'Kitchen staff can only start preparation or mark orders ready.',403);
      if(body.status==='cancelled') {permit(user,management);requireThat((body.reason??'').length>=3,'Provide a reason for cancelling this order.');requireThat(order.paid===order.refunded,'Refund all payments before cancelling an order.',409);}
      if(body.status==='completed')requireThat(order.paid-order.refunded>=order.total,'An order must be fully paid before completion.',409,'PAYMENT_REQUIRED');
      // Cancellation does not replenish cooked food. Stock loss remains visible for review.
      const status=body.status==='served'&&order.type!=='dine-in'&&order.paid-order.refunded>=order.total?'completed':body.status;
      const updated={...order,status,updatedAt:now(),version:order.version+1};store.put('order',updated);
      if(['completed','cancelled'].includes(status))releaseTable(updated);
      audit(user,order.branchId,`order.${status}`,`${order.number}${body.reason?` · ${body.reason}`:''}`);return {ok:true,order:publicOrder(user,updated)};
    });
  });
  app.post('/api/orders/:id/payments',async request=>{
    const user=getUser(request);permit(user,['owner','manager','cashier']);const params=z.object({id}).parse(request.params);
    const body=z.object({commandId:command,expectedVersion:z.number().int().positive(),method,amount,received:money.optional(),reference:z.string().max(200).optional()}).parse(request.body);
    const existing=getOrder(user,params.id);
    return store.command(body.commandId,user.id,`order.payment:${params.id}`,existing.branchId,body,()=>{
      const order=getOrder(user,params.id);versionCheck(order,body.expectedVersion);requireThat(!['cancelled','completed'].includes(order.status),'This order is closed.',409);
      const due=order.total-order.paid;requireThat(body.amount<=due,'Payment exceeds the outstanding balance.',409,'OVERPAYMENT');
      requireThat(order.refunded===0,'A refunded order cannot accept new payments.',409);
      const shift=openShift(order.branchId);requireThat(shift,'Open a cash shift before accepting payments.',409,'SHIFT_REQUIRED');
      const received=body.received??body.amount;requireThat(body.method!=='cash'||received>=body.amount,'Cash received is less than the payment amount.');
      if(body.method!=='cash')requireThat(received===body.amount,'Received amount must equal the payment for non-cash methods.');
      if(body.method==='credit')requireThat(order.customerId,'Select a customer for a credit sale.');
      const payment={id:uid('payment'),orderId:order.id,method:body.method,amount:body.amount,received,change:body.method==='cash'?received-body.amount:0,reference:body.reference??'',createdAt:now()};
      const paid=order.paid+body.amount;const updated:Order={...order,paid,paymentStatus:paid===order.total?'paid':'partial',payments:[...order.payments,payment],updatedAt:now(),version:order.version+1};
      // Payment and preparation are independent: a prepaid takeaway must remain in the kitchen queue.
      if(paid===order.total&&order.type!=='dine-in'&&order.status==='served')updated.status='completed';
      store.put('order',updated);
      if(body.method==='cash')store.put('shift',{...shift,expectedCash:shift.expectedCash+body.amount});
      if(order.customerId) {const customer=store.get<Customer>('customer',order.customerId)!;store.put('customer',{...customer,spent:customer.spent+body.amount,visits:customer.visits+(paid===order.total?1:0),balance:customer.balance+(body.method==='credit'?body.amount:0),points:customer.points+Math.floor(body.amount/10000)});}
      if(updated.status==='completed')releaseTable(updated);
      audit(user,order.branchId,'payment.accepted',`${order.number} · ${body.method} · ${body.amount}`);return {ok:true,order:updated,payment};
    });
  });
  app.post('/api/orders/:id/refunds',async request=>{
    const user=getUser(request);permit(user,management);const params=z.object({id}).parse(request.params);
    const body=z.object({commandId:command,expectedVersion:z.number().int().positive(),amount,reason:z.string().trim().min(3).max(500),method:z.enum(['cash','card','qr','credit']).optional()}).parse(request.body);
    const existing=getOrder(user,params.id);
    return store.command(body.commandId,user.id,`order.refund:${params.id}`,existing.branchId,body,()=>{
      const order=getOrder(user,params.id);versionCheck(order,body.expectedVersion);requireThat(body.amount<=order.paid-order.refunded,'Refund exceeds the unrefunded paid amount.');
      const refundMethod=body.method??order.payments[0]?.method??'cash';const shift=openShift(order.branchId);requireThat(shift,'Open a shift before processing a refund.',409,'SHIFT_REQUIRED');
      const prior=store.list<{id:string;branchId:string;orderId:string;amount:number;method:string}>('refund',order.branchId).filter(x=>x.orderId===order.id&&x.method===refundMethod).reduce((sum,x)=>sum+x.amount,0);
      const paidMethod=order.payments.filter(x=>x.method===refundMethod).reduce((sum,x)=>sum+x.amount,0);requireThat(body.amount<=paidMethod-prior,'Refund exceeds the payment received by this method.');
      if(refundMethod==='cash'){requireThat(shift.expectedCash>=body.amount,'The cash drawer does not contain enough recorded cash.');store.put('shift',{...shift,expectedCash:shift.expectedCash-body.amount});}
      store.put('refund',{id:uid('refund'),branchId:order.branchId,orderId:order.id,amount:body.amount,method:refundMethod,reason:body.reason,createdAt:now(),createdBy:user.id});
      const refunded=order.refunded+body.amount;const updated:Order={...order,refunded,paymentStatus:refunded===order.paid?'refunded':'partial',updatedAt:now(),version:order.version+1};store.put('order',updated);
      if(order.customerId){const c=store.get<Customer>('customer',order.customerId)!;store.put('customer',{...c,spent:Math.max(0,c.spent-body.amount),balance:Math.max(0,c.balance-(refundMethod==='credit'?body.amount:0)),points:Math.max(0,c.points-Math.floor(body.amount/10000))});}
      audit(user,order.branchId,'payment.refunded',`${order.number} · ${body.amount} · ${body.reason}`);return {ok:true,order:updated};
    });
  });
  app.post('/api/inventory/adjust',async request=>{
    const user=getUser(request);permit(user,stores);const body=z.object({commandId:command,branchId:id,itemId:id,quantity:z.number().finite().min(-100000).max(100000).refine(x=>x!==0,'Adjustment cannot be zero.'),reason:z.string().trim().min(3).max(500)}).parse(request.body);scoped(user,body.branchId);
    return store.command(body.commandId,user.id,'inventory.adjust',body.branchId,body,()=>{const item=store.get<InventoryItem>('inventory',body.itemId);requireThat(item&&item.branchId===body.branchId,'Stock item not found in this branch.',404);moveStock(user,item,body.quantity,'adjustment',body.reason);audit(user,body.branchId,'stock.adjusted',`${item.name} · ${body.quantity} · ${body.reason}`);return {ok:true};});
  });
  app.post('/api/inventory',async request=>{
    const user=getUser(request);permit(user,stores);const body=z.object({commandId:command.optional(),branchId:id,name:z.string().trim().min(2).max(120),nameSi:z.string().max(160).default(''),category:z.enum(['ingredient','prepared','packaging','resale']),unit:z.string().trim().min(1).max(30),quantity:z.number().finite().min(0).max(100000).default(0),minimum:z.number().finite().min(0).max(100000).default(0),unitCost:money,supplierId:id.nullish(),menuItemId:id.nullish()}).parse(request.body);scoped(user,body.branchId);
    return store.command(body.commandId??uid('command'),user.id,'inventory.create',body.branchId,body,()=>{
      if(body.supplierId)requireThat(store.get('supplier',body.supplierId),'Supplier not found.',404);
      if(body.menuItemId){requireThat(store.get('menu',body.menuItemId),'Menu item not found.',404);if(body.category==='prepared')requireThat(!store.list<InventoryItem>('inventory',body.branchId).some(x=>x.category==='prepared'&&x.menuItemId===body.menuItemId),'Prepared stock already exists for this menu item.',409);}
      const canonical=body.name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60)||uid('item');
      requireThat(!store.get('inventory',`${body.branchId}-${canonical}`),'A stock item with this name already exists in this branch.',409);
      const item:InventoryItem={id:`${body.branchId}-${canonical}`,branchId:body.branchId,name:body.name,nameSi:body.nameSi||body.name,category:body.category,unit:body.unit,quantity:0,minimum:body.minimum,unitCost:body.unitCost,supplierId:body.supplierId??null,menuItemId:body.menuItemId??null,updatedAt:now()};store.put('inventory',item);if(body.quantity)moveStock(user,item,body.quantity,'opening','Opening stock');audit(user,body.branchId,'stock.item_created',body.name);return {ok:true,item:store.get('inventory',item.id)};
    });
  });
  app.post('/api/production',async request=>{
    const user=getUser(request);permit(user,productionRoles);const body=z.object({commandId:command,branchId:id,menuItemId:id,quantity:z.number().int().positive().max(10000),note:z.string().max(500).default('')}).parse(request.body);scoped(user,body.branchId);
    return store.command(body.commandId,user.id,'production.create',body.branchId,body,()=>{
      const item=store.get<MenuItem>('menu',body.menuItemId);requireThat(item&&item.stockMode==='prepared','Select a menu item that uses prepared stock.');
      const target=store.list<InventoryItem>('inventory',body.branchId).find(x=>x.menuItemId===item.id&&x.category==='prepared');requireThat(target,'Prepared stock item is not configured.',409);
      consume(user,body.branchId,item,body.quantity,body.note||`Production: ${item.name}`,true);moveStock(user,target,body.quantity,'production','Prepared portions');
      const recipe=store.get<Recipe>('recipe',item.id)!;const perPortion=recipe.ingredients.reduce((sum,x)=>sum+(ingredientStock(body.branchId,x.key)?.unitCost??0)*x.quantity,0);
      const batch:ProductionBatch={id:uid('batch'),branchId:body.branchId,menuItemId:item.id,name:item.name,quantity:body.quantity,cost:Math.round(perPortion*body.quantity),note:body.note,createdAt:now(),createdBy:user.id};store.put('production',batch);audit(user,body.branchId,'production.recorded',`${item.name} · ${body.quantity} portions`);return {ok:true,batch:user.role==='kitchen'?{...batch,cost:0}:batch};
    });
  });
  app.post('/api/purchases',async request=>{
    const user=getUser(request);permit(user,stores);const body=z.object({commandId:command,branchId:id,supplierId:id,invoiceNumber:z.string().trim().min(1).max(100),lines:z.array(z.object({itemId:id,quantity,unitCost:money})).min(1).max(100)}).parse(request.body);scoped(user,body.branchId);
    return store.command(body.commandId,user.id,'purchase.create',body.branchId,body,()=>{
      const supplier=store.get<Supplier>('supplier',body.supplierId);requireThat(supplier,'Supplier not found.',404);
      requireThat(!store.list<Purchase>('purchase',body.branchId).some(x=>x.supplierId===body.supplierId&&x.invoiceNumber.toLowerCase()===body.invoiceNumber.toLowerCase()),'This supplier invoice has already been received.',409,'DUPLICATE_INVOICE');
      requireThat(new Set(body.lines.map(x=>x.itemId)).size===body.lines.length,'Combine duplicate stock items into one purchase line.');
      const lines=body.lines.map(x=>{const item=store.get<InventoryItem>('inventory',x.itemId);requireThat(item&&item.branchId===body.branchId,'Stock item not found in this branch.',404);moveStock(user,item,x.quantity,'purchase',body.invoiceNumber);const updated=store.get<InventoryItem>('inventory',item.id)!;const unitCost=updated.quantity>0?Math.round((item.quantity*item.unitCost+x.quantity*x.unitCost)/updated.quantity):x.unitCost;store.put('inventory',{...updated,unitCost,supplierId:supplier.id});return {itemId:item.id,name:item.name,quantity:x.quantity,unitCost:x.unitCost,total:Math.round(x.quantity*x.unitCost)};});
      const total=lines.reduce((sum,x)=>sum+x.total,0);requireThat(total<=1_000_000_000,'Purchase total exceeds the allowed limit.');
      const purchase:Purchase={id:uid('purchase'),branchId:body.branchId,supplierId:supplier.id,supplierName:supplier.name,invoiceNumber:body.invoiceNumber,total,status:'received',createdAt:now(),lines};store.put('purchase',purchase);store.put('supplier',{...supplier,balance:supplier.balance+total});audit(user,body.branchId,'purchase.received',`${supplier.name} · ${body.invoiceNumber}`);return {ok:true,purchase};
    });
  });
  app.post('/api/suppliers',async request=>{
    const user=getUser(request);permit(user,stores);const body=z.object({commandId:command.optional(),name:z.string().trim().min(2).max(120),phone:z.string().trim().min(5).max(30),email:z.union([z.email(),z.literal('')]).default('')}).parse(request.body);
    const branchId=user.branchId??'b1';return store.command(body.commandId??uid('command'),user.id,'supplier.create',branchId,body,()=>{const supplier:Supplier={id:uid('supplier'),name:body.name,phone:body.phone,email:body.email,balance:0};store.put('supplier',supplier);audit(user,branchId,'supplier.created',body.name);return {ok:true,supplier};});
  });
  app.post('/api/customers',async request=>{
    const user=getUser(request);permit(user,sales);const body=z.object({commandId:command.optional(),name:z.string().trim().min(2).max(120),phone:z.string().trim().min(5).max(30),email:z.union([z.email(),z.literal('')]).default('')}).parse(request.body);
    const branchId=user.branchId??'b1';return store.command(body.commandId??uid('command'),user.id,'customer.create',branchId,body,()=>{
      const normalized=body.phone.replace(/[^\d+]/g,'');requireThat(!store.list<Customer>('customer').some(x=>x.phone.replace(/[^\d+]/g,'')===normalized),'A customer with this phone number already exists.',409);
      const customer:Customer={id:uid('customer'),name:body.name,phone:body.phone,email:body.email,visits:0,spent:0,balance:0,points:0,createdAt:now()};store.put('customer',customer);audit(user,branchId,'customer.created',body.name);return {ok:true,customer};
    });
  });
  const menuSchema=z.object({name:z.string().trim().min(2).max(120),nameSi:z.string().max(160).default(''),description:z.string().max(500).default(''),categoryId:id,price:amount,cost:money.default(0),image:z.string().max(500).refine(x=>x.startsWith('/images/')||x.startsWith('https://'),'Use a local /images/ path or HTTPS image URL.'),available:z.boolean().default(true),stockMode:z.enum(['prepared','recipe','untracked']),badge:z.string().max(30).optional(),preparationMinutes:z.number().int().min(0).max(180).default(10)});
  app.post('/api/menu',async request=>{
    const user=getUser(request);permit(user,['owner']);const body=menuSchema.extend({commandId:command.optional()}).parse(request.body);
    return store.command(body.commandId??uid('command'),user.id,'menu.create','b1',body,()=>{requireThat(store.get('category',body.categoryId),'Category not found.',404);const {commandId,...data}=body;const item:MenuItem={...data,id:uid('menu'),nameSi:data.nameSi||data.name};store.put('menu',item);audit(user,'b1','menu.created',item.name);return {ok:true,item};});
  });
  app.patch('/api/menu/:id',async request=>{
    const user=getUser(request);permit(user,['owner']);const params=z.object({id}).parse(request.params);const body=menuSchema.partial().extend({commandId:command.optional()}).parse(request.body);
    return store.command(body.commandId??uid('command'),user.id,`menu.update:${params.id}`,'b1',body,()=>{const item=store.get<MenuItem>('menu',params.id);requireThat(item,'Menu item not found.',404);if(body.categoryId)requireThat(store.get('category',body.categoryId),'Category not found.',404);const {commandId,...data}=body;const updated={...item,...data};store.put('menu',updated);audit(user,'b1','menu.updated',updated.name);return {ok:true,item:updated};});
  });
  app.put('/api/menu/:id/recipe',async request=>{
    const user=getUser(request);permit(user,['owner']);const params=z.object({id}).parse(request.params);const body=z.object({commandId:command,ingredients:z.array(z.object({key:z.string().regex(/^[a-zA-Z0-9_-]+$/),quantity})).min(1).max(50)}).parse(request.body);
    return store.command(body.commandId,user.id,`recipe.update:${params.id}`,'b1',body,()=>{
      requireThat(store.get('menu',params.id),'Menu item not found.',404);
      requireThat(new Set(body.ingredients.map(x=>x.key)).size===body.ingredients.length,'Combine duplicate ingredients into one recipe line.');
      const inventory=store.list<InventoryItem>('inventory');
      for(const line of body.ingredients)requireThat(inventory.some(x=>x.category==='ingredient'&&(x.id===line.key||x.id===`${x.branchId}-${line.key}`)),'Recipe ingredients must use configured ingredient keys.');
      store.put('recipe',{id:params.id,ingredients:body.ingredients});audit(user,'b1','recipe.updated',params.id);return {ok:true};
    });
  });
  app.post('/api/staff',async request=>{
    const user=getUser(request);permit(user,management);const body=z.object({commandId:command.optional(),name:z.string().trim().min(2).max(120),pin:z.string().regex(/^\d{4,12}$/),role:roleSchema,branchId:id.nullable(),phone:z.string().max(30).default('')}).parse(request.body);
    if(body.role==='owner'){permit(user,['owner']);requireThat(body.branchId===null,'Owner accounts must be organization-wide.');}else{requireThat(body.branchId,'Select a branch.');scoped(user,body.branchId);}
    if(user.role==='manager')requireThat(!['owner','manager','accountant'].includes(body.role),'Only the owner can create management accounts.',403);
    return store.command(body.commandId??uid('command'),user.id,'staff.create',body.branchId??'b1',{...body,pin:'[redacted]',pinFingerprint:sha(body.pin)},()=>{
      const credentials=store.db.prepare('SELECT salt,hash FROM credentials').all() as {salt:string;hash:string}[];requireThat(!credentials.some(x=>verifyPin(body.pin,x.salt,x.hash)),'Choose a different PIN; this PIN is already in use.',409);
      const staff:StaffMember={id:uid('staff'),name:body.name,role:body.role,branchId:body.branchId,initials:body.name.split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase(),active:true,phone:body.phone,lastActive:null};store.put('staff',staff);setPin(store,staff.id,body.pin);audit(user,body.branchId??'b1','staff.created',`${staff.name} · ${staff.role}`);return {ok:true,staff};
    });
  });
  app.patch('/api/staff/:id',async request=>{
    const user=getUser(request);permit(user,management);const params=z.object({id}).parse(request.params);const body=z.object({commandId:command.optional(),active:z.boolean()}).parse(request.body);
    const staff=store.get<StaffMember>('staff',params.id);requireThat(staff,'Team member not found.',404);if(staff.branchId)scoped(user,staff.branchId);if(staff.role==='owner'||staff.role==='manager')permit(user,['owner']);requireThat(staff.id!==user.id||body.active,'You cannot deactivate your own account.');
    return store.command(body.commandId??uid('command'),user.id,`staff.update:${staff.id}`,staff.branchId??'b1',body,()=>{store.put('staff',{...staff,active:body.active});if(!body.active)store.db.prepare('DELETE FROM sessions WHERE staff_id=?').run(staff.id);audit(user,staff.branchId??'b1',body.active?'staff.activated':'staff.deactivated',staff.name);return {ok:true};});
  });
  app.post('/api/expenses',async request=>{
    const user=getUser(request);permit(user,finance);const body=z.object({commandId:command,branchId:id,category:z.string().trim().min(2).max(80),description:z.string().trim().min(3).max(500),amount,paymentMethod:z.enum(['cash','card','bank','qr'])}).parse(request.body);scoped(user,body.branchId);
    return store.command(body.commandId,user.id,'expense.create',body.branchId,body,()=>{
      if(body.paymentMethod==='cash'){const shift=openShift(body.branchId);requireThat(shift,'Open a shift before recording a cash expense.',409,'SHIFT_REQUIRED');requireThat(shift.expectedCash>=body.amount,'Cash expense exceeds the expected drawer balance.');store.put('shift',{...shift,expectedCash:shift.expectedCash-body.amount});}
      const expense:Expense={id:uid('expense'),branchId:body.branchId,category:body.category,description:body.description,amount:body.amount,paymentMethod:body.paymentMethod,createdAt:now(),createdBy:user.id};store.put('expense',expense);audit(user,body.branchId,'expense.recorded',`${body.description} · ${body.amount}`);return {ok:true,expense};
    });
  });
  app.post('/api/shifts/open',async request=>{
    const user=getUser(request);permit(user,['owner','manager','cashier']);const body=z.object({commandId:command,branchId:id,openingFloat:money}).parse(request.body);scoped(user,body.branchId);
    return store.command(body.commandId,user.id,'shift.open',body.branchId,body,()=>{requireThat(!openShift(body.branchId),'A cash shift is already open in this branch.',409,'SHIFT_ALREADY_OPEN');const shift:Shift={id:uid('shift'),branchId:body.branchId,openedBy:user.id,openedAt:now(),openingFloat:body.openingFloat,status:'open',closedAt:null,countedCash:null,expectedCash:body.openingFloat,variance:null};store.put('shift',shift);audit(user,body.branchId,'shift.opened',`Opening float ${body.openingFloat}`);return {ok:true,shift};});
  });
  app.post('/api/shifts/:id/close',async request=>{
    const user=getUser(request);permit(user,['owner','manager','cashier']);const params=z.object({id}).parse(request.params);const body=z.object({commandId:command,countedCash:money}).parse(request.body);const shift=store.get<Shift>('shift',params.id);requireThat(shift,'Shift not found.',404);scoped(user,shift.branchId);
    return store.command(body.commandId,user.id,`shift.close:${shift.id}`,shift.branchId,body,()=>{const current=store.get<Shift>('shift',shift.id)!;requireThat(current.status==='open','This shift is already closed.',409);const updated:Shift={...current,status:'closed',closedAt:now(),countedCash:body.countedCash,variance:body.countedCash-current.expectedCash};store.put('shift',updated);audit(user,shift.branchId,'shift.closed',`Cash variance ${updated.variance}`);return {ok:true,shift:updated};});
  });
  app.put('/api/settings',async request=>{
    const user=getUser(request);permit(user,['owner']);const body=z.object({commandId:command.optional(),businessName:z.string().trim().min(2).max(100).optional(),tagline:z.string().max(150).optional(),currency:z.literal('LKR').optional(),taxRate:z.number().min(0).max(100).optional(),serviceChargeRate:z.number().min(0).max(100).optional(),receiptFooter:z.string().max(500).optional(),lowStockAlerts:z.boolean().optional(),autoPrint:z.boolean().optional(),language:z.enum(['si','en']).optional()}).parse(request.body);
    return store.command(body.commandId??uid('command'),user.id,'settings.update','b1',body,()=>{const {commandId,...changes}=body;const updated={...settings(),...changes};store.setMeta('settings',JSON.stringify(updated));store.changes?.push({kind:'settings',id:'settings',branchId:null,value:updated});audit(user,'b1','settings.updated',Object.keys(changes).join(', '));return {ok:true,settings:updated};});
  });
  app.post('/api/backups',async request=>{const user=getUser(request);permit(user,['owner']);const result=await store.backup();audit(user,'b1','backup.created',result.filename);return {filename:result.filename,checksum:result.checksum};});
  app.get('/api/backups/:filename',async(request,reply)=>{const user=getUser(request);permit(user,['owner']);const params=z.object({filename:z.string()}).parse(request.params);const path=store.backupPath(params.filename);reply.header('Content-Type','application/vnd.sqlite3').header('Content-Disposition',`attachment; filename="${params.filename}"`);return reply.send(createReadStream(path));});
  app.post('/api/sync',async request=>{const user=getUser(request);permit(user,management);await sync(true);return {ok:true,sync:syncState(user.role==='owner'?undefined:user.branchId!)};});
  app.get('/api/orders/:id/receipt',async(request,reply)=>{
    const user=getUser(request);permit(user,finance);const params=z.object({id}).parse(request.params);const order=getOrder(user,params.id);const branch=store.get<Branch>('branch',order.branchId)!;const cfg=settings();const format=(n:number)=>(n/100).toLocaleString('en-LK',{minimumFractionDigits:2,maximumFractionDigits:2});
    reply.type('text/html; charset=utf-8');return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(order.number)} · Receipt</title><style>body{font:13px ui-monospace,monospace;color:#111;background:#fff;max-width:300px;margin:30px auto;padding:12px}h1{font-size:20px;text-align:center;margin:0 0 8px}p{text-align:center;line-height:1.5}table{width:100%;border-collapse:collapse}td{padding:5px 0;vertical-align:top}td:last-child{text-align:right;white-space:nowrap}hr{border:0;border-top:1px dashed #999;margin:12px 0}.total{font-size:17px;font-weight:700}button{width:100%;padding:12px;margin:20px 0;border:0;background:#111;color:#fff;cursor:pointer}@media print{body{margin:0;padding:0}button{display:none}@page{size:80mm auto;margin:5mm}}</style></head><body><h1>${html(cfg.businessName)}</h1><p>${html(branch.name)}<br>${html(branch.address)}<br>${html(branch.phone)}</p><hr><div>Receipt ${html(order.number)}</div><div>${html(new Date(order.createdAt).toLocaleString('en-LK',{timeZone:'Asia/Colombo'}))}</div><div>${html(order.type)}${order.tableId?' · '+html(store.get<DiningTable>('table',order.tableId)?.name):''}</div>${store.meta('demo')==='true'?'<p><strong>DEMO — SAMPLE DATA</strong></p>':''}<hr><table>${order.lines.map(x=>`<tr><td>${x.quantity} × ${html(x.name)}<br><small>${format(x.unitPrice)} each</small></td><td>${format(x.lineTotal)}</td></tr>`).join('')}</table><hr><table><tr><td>Subtotal</td><td>${format(order.subtotal)}</td></tr>${order.discount?`<tr><td>Discount</td><td>−${format(order.discount)}</td></tr>`:''}<tr><td>Service charge</td><td>${format(order.serviceCharge)}</td></tr><tr><td>Tax</td><td>${format(order.tax)}</td></tr><tr class="total"><td>Total ${html(cfg.currency)}</td><td>${format(order.total)}</td></tr>${order.payments.map(x=>`<tr><td>Paid · ${html(x.method)}</td><td>${format(x.amount)}</td></tr>${x.change?`<tr><td>Change</td><td>${format(x.change)}</td></tr>`:''}`).join('')}${order.refunded?`<tr><td>Refunded</td><td>${format(order.refunded)}</td></tr>`:''}<tr><td>Balance</td><td>${format(Math.max(0,order.total-order.paid))}</td></tr></table><hr><p>${html(cfg.receiptFooter)}</p><button onclick="window.print()">Print receipt</button></body></html>`;
  });
  return app;
}

declare module 'fastify' { interface FastifyInstance { store: Store } }
