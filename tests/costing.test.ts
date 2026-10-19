import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { productCost, recipeCost, weightedUnitCost, profitability, profitCsv, businessDate, portionIngredients } from '../shared/costing';
import type { Branch, Expense, InventoryItem, MenuItem, Order, Recipe, Settings, Snapshot, User } from '../shared/types';
import { createApp } from '../server/app';
import { LocalDatabase, LocalStore } from '../src/lib/local/db';
import { handleCashier } from '../src/lib/local/cashier';
import { handleCatalog } from '../src/lib/local/catalog';

const branch: Branch = { id: 'b1', name: 'Kitchen', nameSi: 'Kitchen', code: 'KT', address: '', phone: '' };
const item: MenuItem = { id: 'meal', name: 'Rice parcel', nameSi: 'Rice parcel', categoryId: 'rice', description: '', price: 50000, cost: 18000, image: '/images/curry.jpg', available: true, stockMode: 'recipe', preparationMinutes: 5 };
const ingredient = (key: string, cost: number, unit = 'kg'): InventoryItem => ({ id: `b1-${key}`, branchId: 'b1', name: key, nameSi: key, category: 'ingredient', unit, quantity: 100, minimum: 1, unitCost: cost, menuItemId: null, supplierId: null, updatedAt: '2026-01-01T00:00:00Z' });
const stock = [ingredient('rice', 25000), ingredient('chicken', 120000), ingredient('vegetables', 40000), ingredient('egg', 5000, 'pcs')];
const recipe: Recipe = { id: 'meal', ingredients: [{ key: 'rice', quantity: 0.2 }, { key: 'chicken', quantity: 0.15 }, { key: 'vegetables', quantity: 0.15 }, { key: 'egg', quantity: 1 }] };
function order(changes: Partial<Order> = {}): Order {
  return { id: 'o1', number: 'KT-001', branchId: 'b1', type: 'takeaway', tableId: null, customerId: null, status: 'completed', paymentStatus: 'paid', subtotal: 20000, discount: 2000, tax: 1800, serviceCharge: 0, total: 19800, paid: 19800, refunded: 0, note: '', createdAt: '2026-01-02T08:00:00Z', updatedAt: '2026-01-02T08:00:00Z', createdBy: 'owner', version: 1, lines: [{ id: 'l1', menuItemId: 'meal', name: 'Rice parcel', nameSi: 'Rice parcel', quantity: 2, unitPrice: 10000, unitCost: 3000, costBasis: 'captured', lineTotal: 20000, note: '' }], payments: [], ...changes };
}
function fixture(orders: Order[], expenses: Expense[] = []) {
  return { branch, menu: [item], inventory: stock, recipes: [recipe], orders, expenses };
}

test('recipe cost uses measured quantities in stock units and ignores a different branch', () => {
  const cost = recipeCost('meal', [...stock, { ...stock[0], id: 'b2-rice', branchId: 'b2', unitCost: 1 }], [recipe], 'b1');
  assert.equal(cost.unitCost, 34000); // 50 + 180 + 60 + 50 rupees.
  assert.equal(cost.complete, true);
  assert.equal(cost.ingredients[0].unit, 'kg');
  assert.equal(productCost(item, stock, [recipe], 'b1').unitCost, 34000);
  assert.equal(recipeCost('meal', stock.slice(1), [recipe], 'b1').complete, false);
  assert.equal(weightedUnitCost(20, 20000, 10, 300000), 23333);
});

test('a 50-portion batch converts total measured quantities once and rejects invalid yields', () => {
  assert.deepEqual(portionIngredients([{ key: 'rice', quantity: 20 }, { key: 'boxes', quantity: 50 }], 50), [{ key: 'rice', quantity: 0.4 }, { key: 'boxes', quantity: 1 }]);
  assert.throws(() => portionIngredients([{ key: 'rice', quantity: 20 }], 0), /recipe yield/);
  assert.throws(() => portionIngredients([{ key: 'rice', quantity: 20 }], Infinity), /recipe yield/);
  assert.throws(() => portionIngredients([{ key: 'rice', quantity: -20 }], 50), /positive quantity/);
});

test('hub stores batch-yield metadata without dividing canonical quantities again and consumes packaging', async () => {
  const app = await createApp({ databasePath: ':memory:', seed: true });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { pin: '1234' } });
    const headers = { cookie: login.cookies[0].name + '=' + login.cookies[0].value };
    const before = (await app.inject({ url: '/api/bootstrap?branchId=b1', headers })).json<Snapshot>();
    const ingredients = portionIngredients([{ key: 'rice', quantity: 20 }, { key: 'boxes', quantity: 50 }], 50);
    const save = await app.inject({ method: 'PUT', url: '/api/menu/m1/recipe', headers, payload: { commandId: randomUUID(), batchYield: 50, ingredients } });
    assert.equal(save.statusCode, 200, save.body);
    const saved = (await app.inject({ url: '/api/bootstrap?branchId=b1', headers })).json<Snapshot>().recipes.find(recipe => recipe.id === 'm1')!;
    assert.equal(saved.batchYield, 50);
    assert.equal(saved.ingredients[0].quantity, 0.4);
    assert.equal(saved.ingredients[1].quantity, 1);
    const result = await app.inject({ method: 'POST', url: '/api/production', headers, payload: { commandId: randomUUID(), branchId: 'b1', menuItemId: 'm1', quantity: 50 } });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().batch.cost, 665000);
    const after = (await app.inject({ url: '/api/bootstrap?branchId=b1', headers })).json<Snapshot>();
    assert.equal(after.inventory.find(item => item.id === 'b1-rice')!.quantity, before.inventory.find(item => item.id === 'b1-rice')!.quantity - 20);
    assert.equal(after.inventory.find(item => item.id === 'b1-boxes')!.quantity, before.inventory.find(item => item.id === 'b1-boxes')!.quantity - 50);
    const invalid = await app.inject({ method: 'PUT', url: '/api/menu/m1/recipe', headers, payload: { commandId: randomUUID(), batchYield: 0, ingredients } });
    assert.equal(invalid.statusCode, 400);
  } finally { await app.close(); }
});

test('device batch recipes preserve yield and deduct ingredients plus packaging per actual portion count', async () => {
  const db = new LocalDatabase(`batch-costing-${randomUUID()}`);
  const store = new LocalStore(db);
  const owner: User = { id: 'owner', name: 'Owner', initials: 'OW', branchId: null, role: 'owner' };
  try {
    await store.put('branch', branch);
    await store.put('menu', { ...item, stockMode: 'prepared' });
    await store.put('inventory', ingredient('rice', 25000));
    await store.put('inventory', { ...ingredient('boxes', 1000, 'pcs'), category: 'packaging' as const });
    await store.put('inventory', { ...ingredient('prepared', 0, 'portions'), category: 'prepared' as const, menuItemId: item.id, quantity: 0 });
    const call = (path: string, body: unknown, method: string) => db.transaction('rw', db.tables, async () => handleCatalog({ path, method, body: { commandId: randomUUID(), ...(body as object) }, query: new URLSearchParams(), user: owner, store: new LocalStore(db) }));
    await call('/menu/meal/recipe', { batchYield: 50, ingredients: portionIngredients([{ key: 'rice', quantity: 20 }, { key: 'boxes', quantity: 50 }], 50) }, 'PUT');
    const saved = (await store.get<Recipe>('recipe', 'meal'))!;
    assert.equal(saved.batchYield, 50);
    assert.equal(saved.ingredients[0].quantity, 0.4);
    await call('/production', { branchId: 'b1', menuItemId: item.id, quantity: 5 }, 'POST');
    assert.equal((await store.get<InventoryItem>('inventory', 'b1-rice'))!.quantity, 98);
    assert.equal((await store.get<InventoryItem>('inventory', 'b1-boxes'))!.quantity, 95);
    assert.equal((await store.get<InventoryItem>('inventory', 'b1-prepared'))!.unitCost, 11000);
  } finally { await db.delete(); }
});

test('sale-time cost remains unchanged when ingredient and product prices change', () => {
  const data = fixture([order()]);
  const before = profitability(data, '2026-01-02');
  const after = profitability({ ...data, menu: [{ ...item, cost: 999999, price: 900000 }], inventory: stock.map(line => ({ ...line, unitCost: 999999 })) }, '2026-01-02');
  assert.equal(before.costOfSales, 6000);
  assert.equal(before.netSales, 18000);
  assert.deepEqual(after, before);
});

test('refunds remove net revenue, keep consumed food cost, and cancelled food stays as a cost', () => {
  const refund = order({ refunded: 9900 });
  const cancelled = order({ id: 'cancelled', status: 'cancelled', paid: 0, total: 10000, subtotal: 10000, discount: 0, tax: 0, lines: [{ ...refund.lines[0], quantity: 1, lineTotal: 10000, unitCost: 2000 }] });
  const expenses: Expense[] = [
    { id: 'rent', branchId: 'b1', category: 'rent', description: 'Daily rent', amount: 1000, paymentMethod: 'cash', createdAt: refund.createdAt, createdBy: 'owner' },
    { id: 'stock', branchId: 'b1', category: 'inventory', description: 'Stock already in COGS', amount: 5000, paymentMethod: 'cash', createdAt: refund.createdAt, createdBy: 'owner' },
  ];
  const report = profitability(fixture([refund, cancelled], expenses), '2026-01-02');
  assert.equal(report.netSales, 9000);
  assert.equal(report.refundedNetSales, 9000);
  assert.equal(report.costOfSales, 6000);
  assert.equal(report.grossProfit, 3000);
  assert.equal(report.cancelledCost, 2000);
  assert.equal(report.operatingExpenses, 1000);
  assert.equal(report.excludedInventoryExpenses, 5000);
  assert.equal(report.operatingProfit, 0);
  assert.equal(report.products[0].grossProfit, 3000);
});

test('profit records credit and unpaid confirmed bills separately from cash collections; dates use Colombo', () => {
  const sale = order({ paid: 0, paymentStatus: 'unpaid', createdAt: '2026-01-01T19:00:00Z' });
  const credit = order({ id: 'credit', payments: [{ id: 'p1', orderId: 'credit', method: 'credit', amount: 19800, received: 19800, change: 0, reference: '', createdAt: '2026-01-03T08:00:00Z' }] });
  assert.equal(businessDate(sale.createdAt), '2026-01-02');
  const report = profitability(fixture([sale, credit]), '2026-01-02');
  assert.equal(report.netSales, 36000);
  assert.equal(report.outstanding, 19800);
  assert.equal(report.bills, 2);
  assert.equal(profitability(fixture([sale]), '2026-01-01').netSales, 0);
  assert.match(profitCsv(report), /Includes unpaid and credit bills/);
});

test('pre-upgrade bills explicitly use estimated costs and missing cost configuration is counted', () => {
  const old = order();
  delete old.lines[0].unitCost;
  delete old.lines[0].costBasis;
  const report = profitability(fixture([old]), '2026-01-02');
  assert.equal(report.estimatedLines, 1);
  assert.equal(report.costOfSales, 68000);
  assert.equal(report.missingCostLines, 0);
  assert.equal(report.products[0].estimated, true);
  assert.equal(profitability({ ...fixture([old]), inventory: [] }, '2026-01-02').missingCostLines, 1);
});

test('hub captures recipe and prepared stock costs, blends production, and redacts cashier responses', async () => {
  const app = await createApp({ databasePath: ':memory:', seed: true });
  try {
    const login = async (pin: string) => { const response = await app.inject({ method: 'POST', url: '/api/login', payload: { pin } }); assert.equal(response.statusCode, 200, response.body); return { cookie: response.cookies[0].name + '=' + response.cookies[0].value }; };
    const owner = await login('1234'), cashier = await login('2222');
    const before = (await app.inject({ url: '/api/bootstrap?branchId=b1', headers: owner })).json<Snapshot>();
    const prepared = before.inventory.find(line => line.menuItemId === 'm1')!;
    const expectedRecipe = recipeCost('m1', before.inventory, before.recipes, 'b1').unitCost;
    const production = await app.inject({ method: 'POST', url: '/api/production', headers: owner, payload: { commandId: randomUUID(), branchId: 'b1', menuItemId: 'm1', quantity: 2 } });
    assert.equal(production.statusCode, 200, production.body);
    const blended = weightedUnitCost(prepared.quantity, prepared.unitCost, 2, expectedRecipe * 2);
    const create = await app.inject({ method: 'POST', url: '/api/orders', headers: cashier, payload: { commandId: randomUUID(), branchId: 'b1', type: 'takeaway', lines: [{ menuItemId: 'm1', quantity: 1 }, { menuItemId: 'm3', quantity: 1 }] } });
    assert.equal(create.statusCode, 200, create.body);
    assert.equal(create.json().order.lines[0].unitCost, undefined);
    const first = (await app.inject({ url: '/api/bootstrap?branchId=b1', headers: owner })).json<Snapshot>().orders.find(line => line.id === create.json().order.id)!;
    assert.equal(first.lines[0].unitCost, blended);
    assert.equal(first.lines[0].costBasis, 'captured');
    assert.equal(first.lines[1].unitCost, recipeCost('m3', before.inventory, before.recipes, 'b1').unitCost);
    const update = await app.inject({ method: 'PATCH', url: `/api/inventory/${prepared.id}`, headers: owner, payload: { commandId: randomUUID(), branchId: 'b1', unitCost: 99000 } });
    assert.equal(update.statusCode, 200, update.body);
    const after = (await app.inject({ url: '/api/bootstrap?branchId=b1', headers: owner })).json<Snapshot>();
    assert.equal(after.orders.find(line => line.id === first.id)!.lines[0].unitCost, blended);
    const hidden = (await app.inject({ url: '/api/bootstrap?branchId=b1', headers: cashier })).json<Snapshot>().orders.find(line => line.id === first.id)!;
    assert.equal(hidden.lines[0].unitCost, undefined);
    assert.equal(hidden.lines[0].costBasis, undefined);
  } finally { await app.close(); }
});

test('device sales preserve costs in IndexedDB and new prepared production updates weighted cost', async () => {
  const db = new LocalDatabase(`costing-${randomUUID()}`);
  const store = new LocalStore(db);
  const owner: User = { id: 'owner', name: 'Owner', initials: 'OW', branchId: null, role: 'owner' };
  const settings = { taxRate: 0, serviceChargeRate: 0 } as Settings;
  const prepared: InventoryItem = { ...ingredient('prepared', 20000, 'portions'), category: 'prepared', menuItemId: item.id, quantity: 10 };
  try {
    await store.put('branch', branch);
    await store.put('menu', { ...item, stockMode: 'prepared' });
    await store.put('recipe', recipe);
    for (const ingredient of [...stock, prepared]) await store.put('inventory', ingredient);
    await store.setMeta('settings', settings);
    await store.setMeta('deviceId', 'cost-test');
    const request = (path: string, body: unknown, user = owner) => ({ path, method: 'POST', query: new URLSearchParams(), body: { commandId: randomUUID(), ...(body as object) }, store: new LocalStore(db), user });
    await db.transaction('rw', db.tables, async () => handleCatalog(request('/production', { branchId: 'b1', menuItemId: item.id, quantity: 10 })));
    assert.equal((await store.get<InventoryItem>('inventory', prepared.id))!.unitCost, 27000);
    const result = await db.transaction('rw', db.tables, async () => handleCashier(request('/orders', { branchId: 'b1', type: 'takeaway', lines: [{ menuItemId: item.id, quantity: 1 }] }, { ...owner, role: 'cashier', branchId: 'b1' }))) as { order: Order };
    assert.equal(result.order.lines[0].unitCost, undefined);
    const saved = (await store.get<Order>('order', result.order.id))!;
    assert.equal(saved.lines[0].unitCost, 27000);
    assert.equal(saved.lines[0].costBasis, 'captured');
    await store.put('inventory', { ...prepared, unitCost: 90000 });
    assert.equal((await store.get<Order>('order', saved.id))!.lines[0].unitCost, 27000);
  } finally { await db.delete(); }
});
