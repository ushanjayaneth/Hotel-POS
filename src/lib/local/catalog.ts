import { z } from 'zod';
import {isProductImageReference,mediaIdFromReference} from '../../../shared/media.js';
import { weightedUnitCost } from '../../../shared/costing.js';
import type { AuditEvent, Category, CreditEntry, Customer, Expense, InventoryItem, MenuItem, Order, ProductionBatch, Purchase, Recipe, Role, Settings, StaffMember, StockMovement, Supplier, User } from '../../../shared/types.js';
import { now, uid, requireLocal, permitLocal, scopeLocal, type LocalRequest } from './types.js';
import { pinAlreadyUsed, setLocalPin } from './auth.js';

const id = z.string().min(1).max(160);
const command = z.string().min(8).max(160).optional();
const money = z.number().int().min(0).max(1_000_000_000);
const positiveMoney = money.refine(value => value > 0, 'Amount must be greater than zero.');
const quantity = z.number().finite().positive().max(100000);
const stockQuantity = z.number().finite().min(0).max(100000);
const management: Role[] = ['owner', 'manager'];
const stores: Role[] = ['owner', 'manager', 'storekeeper'];
const finance: Role[] = ['owner', 'manager', 'cashier', 'accountant'];
const productionRoles: Role[] = ['owner', 'manager', 'kitchen', 'storekeeper'];
const roundQuantity = (value: number) => Math.round(value * 10000) / 10000;
const role = z.enum(['owner', 'manager', 'cashier', 'waiter', 'kitchen', 'storekeeper', 'accountant']);
const email = z.union([z.email(), z.literal('')]);
const defaults = { receiptPaperWidthMm: 80, receiptContentWidthMm: 72, receiptMarginMm: 2, receiptOffsetMm: 0, receiptFontSize: 10 };
const categorySchema = z.object({ commandId: command, name: z.string().trim().min(2).max(80), icon: z.string().trim().min(1).max(40).default('package') });
const menuSchema = z.object({
  name: z.string().trim().min(2).max(120), nameSi: z.string().max(160).default(''), description: z.string().max(500).default(''), categoryId: id,
  price: positiveMoney, cost: money.default(0), image: z.string().max(500).refine(isProductImageReference, 'Choose a photo link or upload a product photo.'),
  available: z.boolean().default(true), stockMode: z.enum(['prepared', 'recipe', 'untracked']), badge: z.string().max(30).optional(), preparationMinutes: z.number().int().min(0).max(180).default(10),
  barcode: z.string().trim().max(80).regex(/^[A-Za-z0-9 ._/-]*$/).optional(), sku: z.string().trim().max(80).regex(/^[A-Za-z0-9 ._/-]*$/).transform(value => value.toUpperCase()).optional(), reorderLevel: stockQuantity.default(5),
});

async function audit(request: LocalRequest, branchId: string, action: string, detail: string) {
  await request.store.put<AuditEvent>('audit', { id: uid('audit'), branchId, action, actor: request.user.name, detail, createdAt: now() });
}

async function moveStock(request: LocalRequest, item: InventoryItem, delta: number, type: string, reason: string) {
  const next = roundQuantity(item.quantity + delta);
  requireLocal(Number.isFinite(next) && next >= 0, `Insufficient ${item.name}: ${item.quantity} ${item.unit} available.`, 409, 'INSUFFICIENT_STOCK');
  const updated = { ...item, quantity: next, updatedAt: now() };
  await request.store.put('inventory', updated);
  await request.store.put<StockMovement>('movement', { id: uid('stock'), itemId: item.id, branchId: item.branchId, type, quantity: roundQuantity(delta), reason, createdAt: now(), createdBy: request.user.id,...(type==='waste'?{unitCost:item.unitCost,totalCost:Math.round(Math.abs(delta)*item.unitCost)}:{}) });
  return updated;
}

async function ingredientStock(request: LocalRequest, branchId: string, key: string) {
  const stock = await request.store.get<InventoryItem>('inventory', `${branchId}-${key}`) ?? await request.store.get<InventoryItem>('inventory', key);
  return stock?.branchId === branchId ? stock : undefined;
}

async function validateCodes(request: LocalRequest, values: { barcode?: string; sku?: string }, exceptId?: string) {
  const other = (await request.store.list<MenuItem>('menu')).filter(item => item.id !== exceptId);
  if (values.barcode) requireLocal(!other.some(item => item.barcode === values.barcode), 'This barcode is already assigned to another product.', 409, 'DUPLICATE_BARCODE');
  if (values.sku) requireLocal(!other.some(item => item.sku?.toUpperCase() === values.sku?.toUpperCase()), 'This SKU is already assigned to another product.', 409, 'DUPLICATE_SKU');
}

const dateInColombo = (timestamp: string) => new Date(timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' });
const csvField = (value: unknown) => {
  let text = String(value ?? '');
  if (/^\s*[=+@-]/.test(text) && !/^[-+]?\d+(?:\.\d+)?$/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

async function incomeExpenseReport(request: LocalRequest) {
  permitLocal(request.user, finance);
  const query = z.object({ branchId: id.optional(), from: z.iso.date(), to: z.iso.date(), format: z.enum(['csv', 'json']).default('csv') }).parse(Object.fromEntries(request.query));
  const branchId = query.branchId ?? request.user.branchId ?? 'b1';
  await scopeLocal(request.store, request.user, branchId);
  requireLocal(query.from <= query.to, 'The start date must be before the end date.');
  type Row = { date: string; timestamp: string; type: string; reference: string; description: string; method: string; income: number; expense: number };
  const rows: Row[] = [];
  const inRange = (timestamp: string) => { const date = dateInColombo(timestamp); return date >= query.from && date <= query.to; };
  const orders = await request.store.list<Order>('order', branchId);
  const customers = await request.store.list<Customer>('customer');
  for (const order of orders) for (const payment of order.payments) {
    if (payment.method !== 'credit' && inRange(payment.createdAt)) rows.push({ date: dateInColombo(payment.createdAt), timestamp: payment.createdAt, type: 'sale', reference: order.number, description: `Sale ${order.number}`, method: payment.method, income: payment.amount, expense: 0 });
  }
  for (const entry of await request.store.list<CreditEntry>('credit', branchId)) {
    if (entry.type === 'collection' && inRange(entry.createdAt)) {
      const name = customers.find(customer => customer.id === entry.customerId)?.name ?? entry.customerId;
      rows.push({ date: dateInColombo(entry.createdAt), timestamp: entry.createdAt, type: 'collection', reference: entry.reference || entry.id, description: `Customer collection: ${name}${entry.note ? ` · ${entry.note}` : ''}`, method: entry.method, income: entry.amount, expense: 0 });
    }
  }
  const refunds = await request.store.list<{ id: string; branchId: string; orderId: string; method: string; amount: number; reason: string; createdAt: string }>('refund', branchId);
  for (const refund of refunds) if (refund.method !== 'credit' && inRange(refund.createdAt)) rows.push({ date: dateInColombo(refund.createdAt), timestamp: refund.createdAt, type: 'refund', reference: orders.find(order => order.id === refund.orderId)?.number ?? refund.orderId, description: refund.reason, method: refund.method, income: 0, expense: refund.amount });
  for (const expense of await request.store.list<Expense>('expense', branchId)) if (inRange(expense.createdAt)) rows.push({ date: dateInColombo(expense.createdAt), timestamp: expense.createdAt, type: 'expense', reference: expense.id, description: expense.description, method: expense.paymentMethod, income: 0, expense: expense.amount });
  rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const income = rows.reduce((sum, row) => sum + row.income, 0), expense = rows.reduce((sum, row) => sum + row.expense, 0);
  if (query.format === 'json') return { branchId, from: query.from, to: query.to, currency: 'LKR', basis: 'cashflow', income, expense, net: income - expense, rows };
  const amount = (value: number) => (value / 100).toFixed(2);
  return '\ufeff' + [
    ['Date (Asia/Colombo)', 'Type', 'Reference', 'Description', 'Method', 'Income (LKR)', 'Expense (LKR)', 'Net (LKR)'],
    ...rows.map(row => [row.date, row.type, row.reference, row.description, row.method, amount(row.income), amount(row.expense), amount(row.income - row.expense)]),
    ['TOTAL', '', '', '', '', amount(income), amount(expense), amount(income - expense)],
  ].map(row => row.map(csvField).join(',')).join('\r\n');
}

export async function handleCatalog(request: LocalRequest): Promise<unknown | undefined> {
  const { path, method, store, user } = request;
  if(path==='/inventory/wastage'&&method==='POST'){
    permitLocal(user,productionRoles);
    const body=z.object({commandId:command,branchId:id,itemId:id,quantity,reason:z.string().trim().min(3).max(500)}).parse(request.body);
    await scopeLocal(store,user,body.branchId);const item=await store.get<InventoryItem>('inventory',body.itemId);
    requireLocal(item&&item.branchId===body.branchId,'Stock item not found.',404);
    await moveStock(request,item!,-body.quantity,'waste',body.reason);await audit(request,body.branchId,'stock.wastage',`${item!.name}: ${body.quantity} ${item!.unit} · ${body.reason}`);return {ok:true};
  }
  const branch = user.branchId ?? 'b1';
  const categoryMatch = /^\/categories\/([^/]+)$/.exec(path);
  if (path === '/categories' && method === 'POST' || categoryMatch && ['PATCH', 'DELETE'].includes(method)) {
    permitLocal(user, management);
    const categoryId = categoryMatch?.[1];
    const existing = categoryId ? await store.get<Category>('category', categoryId) : undefined;
    if (categoryId) requireLocal(existing, 'Category not found.', 404);
    if (method === 'DELETE') {
      requireLocal(!(await store.list<MenuItem>('menu')).some(item => item.categoryId === categoryId), 'Move or remove this category’s products before deleting it.', 409, 'CATEGORY_IN_USE');
      await store.remove('category', categoryId!);
      await audit(request, branch, 'category.deleted', existing!.name);
      return { ok: true };
    }
    const body = categorySchema.parse(request.body);
    requireLocal(!(await store.list<Category>('category')).some(category => category.id !== categoryId && category.name.toLowerCase() === body.name.toLowerCase()), 'A category with this name already exists.', 409, 'DUPLICATE_CATEGORY');
    const category: Category = { id: categoryId ?? uid('category'), name: body.name, nameSi: body.name, icon: body.icon };
    await store.put('category', category);
    await audit(request, branch, categoryId ? 'category.updated' : 'category.created', category.name);
    return { ok: true, category };
  }

  const menuMatch = /^\/menu\/([^/]+)$/.exec(path);
  if (path === '/menu' && method === 'POST' || menuMatch && method === 'PATCH') {
    permitLocal(user, management);
    const existing = menuMatch ? await store.get<MenuItem>('menu', menuMatch[1]) : undefined;
    if (menuMatch) requireLocal(existing, 'Menu item not found.', 404);
    const values = (existing ? menuSchema.partial() : menuSchema).extend({ commandId: command }).parse(request.body);
    if(values.image){const photoId=mediaIdFromReference(values.image);if(photoId)requireLocal(await store.get('media',photoId),'Upload this product photo before saving.');}
    if (values.categoryId) requireLocal(await store.get('category', values.categoryId), 'Category not found.', 404);
    await validateCodes(request, values, existing?.id);
    const { commandId: _commandId, ...parsed } = values;
    const explicit = existing ? Object.fromEntries(Object.entries(parsed).filter(([key]) => Object.hasOwn(request.body, key))) : parsed;
    const item = { ...existing, ...explicit, id: existing?.id ?? uid('menu') } as MenuItem;
    if (!existing && !item.nameSi) item.nameSi = item.name;
    await store.put('menu', item);
    await audit(request, branch, existing ? 'menu.updated' : 'menu.created', item.name);
    return { ok: true, item };
  }

  if (path === '/inventory/adjust' && method === 'POST') {
    permitLocal(user, stores);
    const body = z.object({ commandId: command, branchId: id, itemId: id, quantity: z.number().finite().min(-100000).max(100000).refine(value => value !== 0, 'Adjustment cannot be zero.'), reason: z.string().trim().min(3).max(500) }).parse(request.body);
    await scopeLocal(store, user, body.branchId);
    const item = await store.get<InventoryItem>('inventory', body.itemId);
    requireLocal(item && item.branchId === body.branchId, 'Stock item not found in this branch.', 404);
    await moveStock(request, item!, body.quantity, 'adjustment', body.reason);
    await audit(request, body.branchId, 'stock.adjusted', `${item!.name} · ${body.quantity} · ${body.reason}`);
    return { ok: true };
  }

  if (path === '/inventory' && method === 'POST') {
    permitLocal(user, stores);
    const body = z.object({ commandId: command, branchId: id, name: z.string().trim().min(2).max(120), nameSi: z.string().max(160).default(''), category: z.enum(['ingredient', 'prepared', 'packaging', 'resale']), unit: z.string().trim().min(1).max(30), quantity: stockQuantity.default(0), minimum: stockQuantity.optional(), unitCost: money, supplierId: id.nullish(), menuItemId: id.nullish() }).parse(request.body);
    await scopeLocal(store, user, body.branchId);
    if (body.supplierId) requireLocal(await store.get('supplier', body.supplierId), 'Supplier not found.', 404);
    let linkedProduct: MenuItem | undefined;
    if (body.menuItemId) {
      linkedProduct = await store.get<MenuItem>('menu', body.menuItemId);
      requireLocal(linkedProduct, 'Menu item not found.', 404);
      if (['prepared', 'resale'].includes(body.category)) requireLocal(!(await store.list<InventoryItem>('inventory', body.branchId)).some(item => ['prepared', 'resale'].includes(item.category) && item.menuItemId === body.menuItemId), 'Linked sale stock already exists for this menu item.', 409);
    }
    const canonical = body.name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || uid('item');
    const stockId = `${body.branchId}-${canonical}`;
    requireLocal(!await store.get('inventory', stockId), 'A stock item with this name already exists in this branch.', 409);
    const minimum = body.minimum ?? (linkedProduct && ['prepared', 'resale'].includes(body.category) ? linkedProduct.reorderLevel ?? 5 : 0);
    let item: InventoryItem = { id: stockId, branchId: body.branchId, name: body.name, nameSi: body.nameSi || body.name, category: body.category, unit: body.unit, quantity: 0, minimum, unitCost: body.unitCost, supplierId: body.supplierId ?? null, menuItemId: body.menuItemId ?? null, updatedAt: now() };
    await store.put('inventory', item);
    if (body.quantity) item = await moveStock(request, item, body.quantity, 'opening', 'Opening stock');
    await audit(request, body.branchId, 'stock.item_created', body.name);
    return { ok: true, item };
  }

  const inventoryMatch = /^\/inventory\/([^/]+)$/.exec(path);
  if (inventoryMatch && method === 'PATCH') {
    permitLocal(user, stores);
    const body = z.object({ commandId: command, branchId: id, quantity: stockQuantity.optional(), minimum: stockQuantity.optional(), unitCost: money.optional(), expectedQuantity: z.number().finite().min(0).optional(), reason: z.string().trim().min(3).max(500).default('Product stock update') }).parse(request.body);
    await scopeLocal(store, user, body.branchId);
    let item = await store.get<InventoryItem>('inventory', inventoryMatch[1]);
    requireLocal(item && item.branchId === body.branchId, 'Stock item not found in this branch.', 404);
    if (body.expectedQuantity !== undefined) requireLocal(item!.quantity === body.expectedQuantity, 'This stock quantity changed while you were editing. Refresh before saving.', 409, 'STOCK_VERSION_CONFLICT');
    if (body.quantity !== undefined && body.quantity !== item!.quantity) item = await moveStock(request, item!, body.quantity - item!.quantity, 'adjustment', body.reason);
    const updated: InventoryItem = { ...item!, minimum: body.minimum ?? item!.minimum, unitCost: body.unitCost ?? item!.unitCost, updatedAt: now() };
    await store.put('inventory', updated);
    await audit(request, body.branchId, 'stock.item_updated', `${updated.name} · ${body.reason}`);
    return { ok: true, item: updated };
  }

  const recipeMatch = /^\/menu\/([^/]+)\/recipe$/.exec(path);
  if (recipeMatch && method === 'PUT') {
    permitLocal(user, ['owner']);
    const body = z.object({ commandId: command, batchYield: z.number().finite().min(1).max(100000).default(1), ingredients: z.array(z.object({ key: z.string().regex(/^[A-Za-z0-9_-]+$/), quantity })).min(1).max(50) }).parse(request.body);
    requireLocal(await store.get('menu', recipeMatch[1]), 'Menu item not found.', 404);
    requireLocal(new Set(body.ingredients.map(line => line.key)).size === body.ingredients.length, 'Combine duplicate ingredients into one recipe line.');
    const inventory = await store.list<InventoryItem>('inventory');
    for (const line of body.ingredients) requireLocal(inventory.some(item => ['ingredient', 'packaging'].includes(item.category) && (item.id === line.key || item.id === `${item.branchId}-${line.key}`)), 'Recipes must use configured ingredients or packaging.');
    await store.put<Recipe>('recipe', { id: recipeMatch[1], ingredients: body.ingredients, batchYield: body.batchYield });
    await audit(request, branch, 'recipe.updated', recipeMatch[1]);
    return { ok: true };
  }

  if (path === '/production' && method === 'POST') {
    permitLocal(user, productionRoles);
    const body = z.object({ commandId: command, branchId: id, menuItemId: id, quantity: z.number().int().positive().max(10000), note: z.string().max(500).default('') }).parse(request.body);
    await scopeLocal(store, user, body.branchId);
    const menu = await store.get<MenuItem>('menu', body.menuItemId);
    requireLocal(menu && menu.stockMode === 'prepared', 'Select a menu item that uses prepared stock.');
    const target = (await store.list<InventoryItem>('inventory', body.branchId)).find(item => item.menuItemId === menu!.id && item.category === 'prepared');
    requireLocal(target, 'Prepared stock item is not configured.', 409);
    const recipe = await store.get<Recipe>('recipe', menu!.id);
    requireLocal(recipe && recipe.ingredients.length > 0, `No recipe is configured for ${menu!.name}.`, 409, 'RECIPE_REQUIRED');
    let totalCost = 0;
    for (const ingredient of recipe!.ingredients) {
      const stock = await ingredientStock(request, body.branchId, ingredient.key);
      requireLocal(stock && ['ingredient', 'packaging'].includes(stock.category), 'Recipe ingredient or packaging is missing in this branch.', 409);
      totalCost += stock!.unitCost * ingredient.quantity * body.quantity;
      await moveStock(request, stock!, -ingredient.quantity * body.quantity, 'production', body.note || `Production: ${menu!.name}`);
    }
    const produced = await moveStock(request, target!, body.quantity, 'production', 'Prepared portions');
    requireLocal(Number.isSafeInteger(Math.round(totalCost)) && totalCost <= 1_000_000_000, 'Production cost exceeds the allowed limit.');
    await store.put('inventory', { ...produced, unitCost: weightedUnitCost(target!.quantity, target!.unitCost, body.quantity, Math.round(totalCost)), updatedAt: now() });
    const batch: ProductionBatch = { id: uid('batch'), branchId: body.branchId, menuItemId: menu!.id, name: menu!.name, quantity: body.quantity, cost: Math.round(totalCost), note: body.note, createdAt: now(), createdBy: user.id };
    await store.put('production', batch);
    await audit(request, body.branchId, 'production.recorded', `${menu!.name} · ${body.quantity} portions`);
    return { ok: true, batch: user.role === 'kitchen' ? { ...batch, cost: 0 } : batch };
  }

  if (path === '/suppliers' && method === 'POST') {
    permitLocal(user, stores);
    const body = z.object({ commandId: command, name: z.string().trim().min(2).max(120), phone: z.string().trim().min(5).max(30), email: email.default('') }).parse(request.body);
    const supplier: Supplier = { id: uid('supplier'), name: body.name, phone: body.phone, email: body.email, balance: 0 };
    await store.put('supplier', supplier);
    await audit(request, branch, 'supplier.created', supplier.name);
    return { ok: true, supplier };
  }

  if (path === '/purchases' && method === 'POST') {
    permitLocal(user, stores);
    const body = z.object({ commandId: command, branchId: id, supplierId: id, invoiceNumber: z.string().trim().min(1).max(100), lines: z.array(z.object({ itemId: id, quantity, unitCost: money })).min(1).max(100) }).parse(request.body);
    await scopeLocal(store, user, body.branchId);
    const supplier = await store.get<Supplier>('supplier', body.supplierId);
    requireLocal(supplier, 'Supplier not found.', 404);
    requireLocal(!(await store.list<Purchase>('purchase', body.branchId)).some(purchase => purchase.supplierId === body.supplierId && purchase.invoiceNumber.toLowerCase() === body.invoiceNumber.toLowerCase()), 'This supplier invoice has already been received.', 409, 'DUPLICATE_INVOICE');
    requireLocal(new Set(body.lines.map(line => line.itemId)).size === body.lines.length, 'Combine duplicate stock items into one purchase line.');
    const total = body.lines.reduce((sum, line) => sum + Math.round(line.quantity * line.unitCost), 0);
    requireLocal(Number.isSafeInteger(total) && total <= 1_000_000_000, 'Purchase total exceeds the allowed limit.');
    const lines: Purchase['lines'] = [];
    for (const line of body.lines) {
      const item = await store.get<InventoryItem>('inventory', line.itemId);
      requireLocal(item && item.branchId === body.branchId, 'Stock item not found in this branch.', 404);
      const updated = await moveStock(request, item!, line.quantity, 'purchase', body.invoiceNumber);
      const unitCost = updated.quantity > 0 ? Math.round((item!.quantity * item!.unitCost + line.quantity * line.unitCost) / updated.quantity) : line.unitCost;
      await store.put('inventory', { ...updated, unitCost, supplierId: supplier!.id });
      lines.push({ itemId: item!.id, name: item!.name, quantity: line.quantity, unitCost: line.unitCost, total: Math.round(line.quantity * line.unitCost) });
    }
    const purchase: Purchase = { id: uid('purchase'), branchId: body.branchId, supplierId: supplier!.id, supplierName: supplier!.name, invoiceNumber: body.invoiceNumber, total, status: 'received', createdAt: now(), lines };
    await store.put('purchase', purchase);
    await store.put('supplier', { ...supplier!, balance: supplier!.balance + total });
    await audit(request, body.branchId, 'purchase.received', `${supplier!.name} · ${body.invoiceNumber}`);
    return { ok: true, purchase };
  }

  const staffMatch = /^\/staff\/([^/]+)$/.exec(path);
  if (path === '/staff' && method === 'POST' || staffMatch && method === 'PATCH') {
    permitLocal(user, management);
    const existing = staffMatch ? await store.get<StaffMember>('staff', staffMatch[1]) : undefined;
    if (staffMatch) requireLocal(existing, 'Team member not found.', 404);
    if (existing?.branchId) await scopeLocal(store, user, existing.branchId);
    if (existing && ['owner', 'manager', 'accountant'].includes(existing.role)) permitLocal(user, ['owner']);
    const schema = z.object({ commandId: command, name: z.string().trim().min(2).max(120), pin: z.string().regex(/^\d{4,12}$/), role, branchId: id.nullable(), phone: z.string().max(30).default(''), active: z.boolean().optional() });
    const body = (existing ? schema.partial() : schema).parse(request.body);
    const targetRole = body.role ?? existing!.role;
    const targetBranch = Object.hasOwn(body, 'branchId') ? body.branchId : existing?.branchId;
    if (targetRole === 'owner') { permitLocal(user, ['owner']); requireLocal(targetBranch === null, 'Owner accounts must be organization-wide.'); }
    else { requireLocal(targetBranch, 'Select a branch.'); await scopeLocal(store, user, targetBranch!); }
    if (user.role === 'manager') requireLocal(!['owner', 'manager', 'accountant'].includes(targetRole), 'Only the owner can create management accounts.', 403);
    requireLocal(!(existing?.id === user.id && body.active === false), 'You cannot deactivate your own account.');
    const name = body.name ?? existing!.name;
    const staff: StaffMember = { id: existing?.id ?? uid('staff'), name, role: targetRole, branchId: targetBranch!, initials: name.split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase(), active: body.active ?? existing?.active ?? true, phone: body.phone ?? existing?.phone ?? '', lastActive: existing?.lastActive ?? null };
    if (body.pin) {
      requireLocal(!await pinAlreadyUsed(store, body.pin, staff.id), 'Choose a different PIN; this PIN is already in use.', 409, 'DUPLICATE_PIN');
      await setLocalPin(store, staff.id, body.pin);
    }
    await store.put('staff', staff);
    if (!staff.active || existing && body.pin) await store.db.sessions.where('staffId').equals(staff.id).delete();
    await audit(request, staff.branchId ?? branch, existing ? 'staff.updated' : 'staff.created', `${staff.name} · ${staff.role}`);
    return { ok: true, staff };
  }

  if (path === '/settings' && method === 'PUT') {
    permitLocal(user, ['owner']);
    const body = z.object({ commandId: command, businessName: z.string().trim().min(2).max(100).optional(), tagline: z.string().max(150).optional(), currency: z.literal('LKR').optional(), taxRate: z.number().finite().min(0).max(100).optional(), serviceChargeRate: z.number().finite().min(0).max(100).optional(), receiptFooter: z.string().max(500).optional(), lowStockAlerts: z.boolean().optional(), autoPrint: z.boolean().optional(), language: z.enum(['si', 'en']).optional(), receiptPaperWidthMm: z.number().finite().min(40).max(120).optional(), receiptContentWidthMm: z.number().finite().min(20).max(120).optional(), receiptMarginMm: z.number().finite().min(0).max(15).optional(), receiptOffsetMm: z.number().finite().min(-30).max(30).optional(), receiptFontSize: z.number().finite().min(6).max(18).optional() }).parse(request.body);
    const { commandId: _commandId, ...changes } = body;
    const settings = { ...defaults, ...await store.meta<Partial<Settings>>('settings'), ...changes } as Settings;
    requireLocal(settings.receiptContentWidthMm + 2 * settings.receiptMarginMm <= settings.receiptPaperWidthMm, 'Receipt content width and margins must fit within the paper width.');
    requireLocal(Math.abs(settings.receiptOffsetMm) <= (settings.receiptPaperWidthMm - settings.receiptContentWidthMm) / 2 - settings.receiptMarginMm, 'Receipt offset would move the content outside the printable area.');
    await store.setMeta('settings', settings);
    await audit(request, branch, 'settings.updated', Object.keys(changes).join(', '));
    return { ok: true, settings };
  }

  if (path === '/reports/income-expenses' && method === 'GET') return incomeExpenseReport(request);
  return undefined;
}
