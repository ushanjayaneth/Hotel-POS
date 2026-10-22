import Dexie from 'dexie';
import {ZodError} from 'zod';
import type {AuditEvent, Branch, Category, CreditEntry, Customer, DiningTable, Expense, HeldBill, InventoryItem, MenuItem, Order, ProductionBatch, Purchase, Recipe, Role, Settings, Shift, Snapshot, StaffMember, StockMovement, Supplier, User} from '../../../shared/types.js';
import {localDb, LocalStore, type LocalDatabase, type LocalChange} from './db.js';
import {forgetLocalSession, getLocalUser, localPinFingerprint, localSessionHash, loginLocal, logoutLocal, publicLocalUser} from './auth.js';
import {getLocalWorkspaceInfo, initializeLocalWorkspace} from './seed.js';
import {handleCashier} from './cashier.js';
import {handleCatalog} from './catalog.js';
import {handleMedia} from './media.js';
import {LocalError, localStorageError, now, requireLocal, scopeLocal, sha256, stable, uid, type LocalRequest} from './types.js';
import {productStockState} from '../../../shared/stock.js';

export {getLocalUser, getLocalWorkspaceInfo, initializeLocalWorkspace};
export type {LocalWorkspaceInfo} from './types.js';
const sales: Role[] = ['owner','manager','cashier','waiter'];
const financial: Role[] = ['owner','manager','cashier','accountant'];
const management: Role[] = ['owner','manager'];
const stores: Role[] = ['owner','manager','storekeeper'];
const productionRoles: Role[] = ['owner','manager','kitchen','storekeeper'];
const changed = () => {if (typeof window !== 'undefined') {window.dispatchEvent(new CustomEvent('local-workspace-change'));if(typeof BroadcastChannel!=='undefined'){const channel=new BroadcastChannel('demo-hotel-device-changes');channel.postMessage({changed:true});channel.close();}}};

function publicOrder(user: User, order: Order): Order {
  const lines=['owner','manager','accountant'].includes(user.role)?order.lines:order.lines.map(({unitCost:_,costBasis:__,...line})=>line);
  if (user.role === 'kitchen') return {...order,customerId:null,subtotal:0,discount:0,cartDiscount:0,tax:0,serviceCharge:0,total:0,paid:0,refunded:0,payments:[],lines:lines.map(line=>({...line,unitPrice:0,discount:0,lineTotal:0}))};
  return {...order,lines,...(user.role==='waiter'?{payments:[]}:{})};
}
export async function bootstrap(store: LocalStore, user: User, query: URLSearchParams): Promise<Snapshot> {
  const branches = await store.list<Branch>('branch');
  const branchId = await scopeLocal(store, user, query.get('branchId') ?? user.branchId ?? await store.meta<string>('activeBranchId') ?? branches[0]?.id ?? 'b1');
  const isFinance = financial.includes(user.role), isManagement = management.includes(user.role);
  const isStore = stores.includes(user.role) || productionRoles.includes(user.role) || user.role === 'accountant';
  const maySeeCosts = isManagement || ['storekeeper','accountant'].includes(user.role);
  const [categories, menu, recipes, inventory, tables, orders, heldBills, credits, movements, production, suppliers, purchases, customers, staff, expenses, shifts, audit, settings, lastBackup] = await Promise.all([
    store.list<Category>('category'),store.list<MenuItem>('menu'),store.list<Recipe>('recipe'),store.list<InventoryItem>('inventory',branchId),
    store.list<DiningTable>('table',branchId),store.list<Order>('order',branchId),store.list<HeldBill>('held',branchId),store.list<CreditEntry>('credit',branchId),
    store.list<StockMovement>('movement',branchId),store.list<ProductionBatch>('production',branchId),store.list<Supplier>('supplier'),store.list<Purchase>('purchase',branchId),
    store.list<Customer>('customer'),store.list<StaffMember>('staff'),store.list<Expense>('expense',branchId),store.list<Shift>('shift',branchId),store.list<AuditEvent>('audit',branchId),
    store.meta<Settings>('settings'),store.meta<string>('lastBackup'),
  ]);
  requireLocal(settings, 'Workspace settings are missing. Restore a verified backup.', 409, 'WORKSPACE_RECOVERY_REQUIRED');
  const ingredient = (key: string) => inventory.find(item => item.id === `${branchId}-${key}` || item.id === key);
  const sellable = (item: MenuItem) => {
    if (!item.available) return false;
    if (item.stockMode === 'untracked') return true;
    if (item.stockMode === 'prepared') return inventory.some(stock => stock.menuItemId === item.id && ['prepared','resale'].includes(stock.category) && stock.quantity >= 1);
    const recipe = recipes.find(recipe => recipe.id === item.id);
    return Boolean(recipe?.ingredients.length && recipe.ingredients.every(line => (ingredient(line.key)?.quantity ?? 0) >= line.quantity));
  };
  const balance = (customerId: string) => credits.filter(entry=>entry.customerId===customerId).reduce((sum,entry)=>sum+(entry.type==='sale'?entry.amount:-entry.amount),0);
  return {
    user,branches:branches.filter(branch=>user.role==='owner'||branch.id===user.branchId),branch:branches.find(branch=>branch.id===branchId)!,categories,
    menu:menu.map(item=>{const stock=productStockState(item,inventory,recipes,branchId);return {...item,reorderLevel:item.reorderLevel??stock.threshold,cost:maySeeCosts?item.cost:0,enabled:item.available,available:sellable(item),stockQuantity:stock.quantity,lowStock:stock.low};}),recipes:isStore?recipes:[],tables,
    orders:sales.includes(user.role)||user.role==='kitchen'||isFinance?orders.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(order=>publicOrder(user,order)):[],
    heldBills:sales.includes(user.role)?heldBills.filter(bill=>bill.status==='held').sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)):[],
    creditEntries:isFinance?credits.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)):[],
    inventory:isStore?inventory.map(item=>maySeeCosts?item:{...item,unitCost:0}):[],stockMovements:isStore?movements.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).filter((row,index)=>index<500||row.type==='waste').map(row=>maySeeCosts?row:{...row,unitCost:undefined,totalCost:undefined}):[],
    production:productionRoles.includes(user.role)||user.role==='accountant'?production.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(item=>maySeeCosts?item:{...item,cost:0}):[],
    suppliers:stores.includes(user.role)||user.role==='accountant'?suppliers.map(supplier=>user.role==='owner'?supplier:{...supplier,balance:purchases.filter(item=>item.supplierId===supplier.id).reduce((sum,item)=>sum+item.total,0)}):[],
    purchases:stores.includes(user.role)||user.role==='accountant'?purchases.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)):[],
    customers:sales.includes(user.role)||isFinance?customers.map(customer=>user.role==='waiter'?{...customer,spent:0,balance:0,points:0}:isFinance?{...customer,balance:balance(customer.id)}:customer):[],
    staff:isManagement?staff.filter(staff=>user.role==='owner'||staff.branchId===branchId):[],
    expenses:isFinance?expenses.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)):[],shifts:isFinance?shifts.sort((a,b)=>b.openedAt.localeCompare(a.openedAt)):[],
    audit:isManagement?audit.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,300):[],
    sync:{configured:false,pending:0,synced:0,failed:0,lastSync:null,lastError:null,lastBackup:lastBackup??null,hubOnline:true},settings,serverTime:now(),
  };
}

function uniqueChanges(changes: LocalChange[]): LocalChange[] {
  const latest = new Map<string, LocalChange>();
  for (const change of changes) latest.set(`${change.kind}:${change.id}`, change);
  return [...latest.values()];
}
async function route(request: LocalRequest): Promise<unknown> {
  const media=await handleMedia(request);if(media!==undefined)return media;
  const cashier = await handleCashier(request);
  if (cashier !== undefined) return cashier;
  const catalog = await handleCatalog(request);
  if (catalog !== undefined) return catalog;
  throw new LocalError(404, 'This action is not available in the device workspace.', 'LOCAL_ROUTE_NOT_FOUND');
}
async function currentUser(db: LocalDatabase, sessionHash: string | null): Promise<User> {
  requireLocal(sessionHash, 'Please sign in to continue.', 401, 'UNAUTHENTICATED');
  const session = await db.sessions.get(sessionHash);
  requireLocal(session && session.expiresAt > Date.now(), 'Please sign in to continue.', 401, 'UNAUTHENTICATED');
  const staff = (await db.records.get(['staff', session.staffId]))?.value as StaffMember | undefined;
  requireLocal(staff?.active, 'This account is inactive. Please sign in again.', 401, 'UNAUTHENTICATED');
  return publicLocalUser(staff);
}

/** Constructing another adapter is useful for isolated storage/recovery tests. */
export function createLocalApi(db: LocalDatabase = localDb) {
  return async function localApi<T = unknown>(inputPath: string, body?: unknown, inputMethod?: string): Promise<T> {
    try {
      const url = new URL(inputPath.startsWith('/') ? inputPath : `/${inputPath}`, 'https://device.workspace');
      const path = (url.pathname.replace(/^\/api(?=\/|$)/, '') || '/').replace(/\/$/, '') || '/';
      const method = (inputMethod ?? (body === undefined ? 'GET' : 'POST')).toUpperCase();
      requireLocal(['GET','POST','PUT','PATCH','DELETE'].includes(method), 'Unsupported request method.', 405);
      if (path === '/health' && method === 'GET') return {ok:true,service:'demo-hotel-device-workspace',database:'indexeddb',time:now()} as T;
      if (path === '/session' && method === 'GET') return {user:await getLocalUser(db),demo:(await getLocalWorkspaceInfo(db))?.demo??false} as T;
      if (path === '/login' && method === 'POST') {
        const input = body as {pin?: unknown; staffId?: unknown} | undefined;
        requireLocal(input && typeof input.pin === 'string', 'Enter your staff PIN.');
        requireLocal(input.staffId === undefined || typeof input.staffId === 'string', 'Invalid staff account.');
        return {user:await loginLocal(input.pin,input.staffId,db)} as T;
      }
      if (path === '/logout' && method === 'POST') {await logoutLocal(db); return {ok:true} as T;}
      requireLocal(await getLocalWorkspaceInfo(db), 'Set up this device before continuing.', 409, 'SETUP_REQUIRED');
      const sessionHash = await localSessionHash(db);
      if (path === '/bootstrap' && method === 'GET') {
        const result = await db.transaction('r',db.records,db.metadata,db.sessions,async()=>bootstrap(new LocalStore(db),await currentUser(db,sessionHash),url.searchParams));
        // Branch selection is a preference, not a business mutation.
        if((await db.metadata.get('activeBranchId'))?.value!==result.branch.id)await db.metadata.put({key:'activeBranchId',value:result.branch.id}).catch(()=>{});
        return result as T;
      }
      if (path.startsWith('/devices/')) throw new LocalError(501, 'OS printer discovery and LAN probes need a branch hub. Use this device\'s print dialog or scanner test.', 'HUB_FEATURE_REQUIRED');
      if (path === '/sync') throw new LocalError(501, 'This device has no cloud connection configured. Local transactions remain on this device; export an encrypted backup.', 'CLOUD_NOT_CONFIGURED');
      if (method === 'GET') return await db.transaction('r',db.records,db.metadata,db.sessions,async()=>route({path,method,query:url.searchParams,body,user:await currentUser(db,sessionHash),store:new LocalStore(db)})) as T;

      requireLocal(body === undefined || (body !== null && typeof body === 'object' && !Array.isArray(body)), 'Invalid request body.');
      const payload = (body ?? {}) as Record<string,unknown>;
      const commandId = payload.commandId ?? uid('command');
      requireLocal(typeof commandId === 'string' && commandId.length >= 8 && commandId.length <= 160, 'Invalid command ID.');
      const workspace = (await getLocalWorkspaceInfo(db))!;
      const hashBody: Record<string, unknown> = {...payload,commandId};
      if (typeof payload.pin === 'string') hashBody.pin = await localPinFingerprint(payload.pin,workspace.workspaceId);
      const hash = await sha256(stable({path,method,query:[...url.searchParams.entries()].sort(),body:hashBody}));
      const result = await db.transaction('rw',db.tables,async()=>{
        const user = await currentUser(db,sessionHash);
        const previous = await db.commands.get(commandId);
        if (previous) {
          requireLocal(previous.actor===user.id&&previous.hash===hash,'This command ID was already used for a different operation.',409,'IDEMPOTENCY_CONFLICT');
          return previous.response;
        }
        const store = new LocalStore(db);
        // IDB operations must run in their transaction zone. Only the credential
        // helpers use waitFor around their independent Web Crypto calculations.
        const response = await route({path,method,query:url.searchParams,body:{...payload,commandId},user,store});
        const createdAt = now();
        const sequence = ((await store.meta<number>('journalSequence'))??0)+1;
        await db.metadata.put({key:'journalSequence',value:sequence});
        const changes = uniqueChanges(store.changes);
        const branchId = typeof payload.branchId==='string'?payload.branchId:changes.find(change=>change.branchId)?.branchId??user.branchId;
        await db.journal.put({id:uid('journal'),sequence,commandId,actor:user.id,action:`${method} ${path}`,branchId:branchId??null,createdAt,changes});
        await db.commands.put({id:commandId,actor:user.id,hash,response,createdAt});
        return response;
      });
      changed();
      return result as T;
    } catch (error) {
      if (error instanceof ZodError) throw new LocalError(400,error.issues.map(issue=>`${issue.path.join('.')||'request'}: ${issue.message}`).join('; '),'VALIDATION_ERROR');
      throw localStorageError(error);
    }
  };
}

export const localApi = createLocalApi();
