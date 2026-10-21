import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Branch, CreditEntry, InventoryItem, MenuItem, Order, Settings, StaffMember, User } from '../shared/types';
import { LocalDatabase, LocalStore } from '../src/lib/local/db';
import { handleCatalog } from '../src/lib/local/catalog';
import { LocalError } from '../src/lib/local/types';
import { setLocalPin } from '../src/lib/local/auth';

const owner: User = { id: 'owner', name: 'Owner', role: 'owner', branchId: null, initials: 'OW' };
const manager: User = { id: 'manager', name: 'Manager', role: 'manager', branchId: 'b1', initials: 'MA' };
const cashier: User = { id: 'cashier', name: 'Cashier', role: 'cashier', branchId: 'b1', initials: 'CA' };
const settings: Settings = { businessName: 'Local hotel', tagline: '', currency: 'LKR', taxRate: 0, serviceChargeRate: 0, receiptFooter: 'Thank you', lowStockAlerts: true, autoPrint: false, language: 'en', receiptPaperWidthMm: 80, receiptContentWidthMm: 72, receiptMarginMm: 2, receiptOffsetMm: 0, receiptFontSize: 10 };

async function fixture() {
  const db = new LocalDatabase(`catalog-test-${crypto.randomUUID()}`);
  await db.open();
  const store = new LocalStore(db);
  for (const branchId of ['b1', 'b2']) await store.put<Branch>('branch', { id: branchId, name: branchId, nameSi: branchId, code: branchId.toUpperCase(), address: '', phone: '' });
  await store.put('category', { id: 'meals', name: 'Meals', nameSi: 'Meals', icon: 'meal' });
  await store.setMeta('settings', settings);
  const call = async (method: string, path: string, body: unknown = {}, user = owner): Promise<any> => {
    const url = new URL(path, 'https://local.invalid');
    return db.transaction('rw', db.tables, async () => handleCatalog({ path: url.pathname, query: url.searchParams, method, body, user, store: new LocalStore(db) }));
  };
  return { db, store, call };
}

function failure(code: string, status = 409) {
  return (error: unknown) => error instanceof LocalError && error.code === code && error.status === status;
}

const product = (name: string, values = {}) => ({ name, description: 'Original product details', categoryId: 'meals', price: 15000, cost: 5000, image: '/images/chicken-rice.jpg', stockMode: 'prepared', preparationMinutes: 12, ...values });
const stock = (id: string, values: Partial<InventoryItem> = {}): InventoryItem => ({ id, branchId: 'b1', name: id, nameSi: id, category: 'ingredient', unit: 'kg', quantity: 10, minimum: 1, unitCost: 100, supplierId: null, menuItemId: null, updatedAt: new Date().toISOString(), ...values });

test('offline catalog preserves omitted fields and rejects duplicate categories and scanner identifiers', async () => {
  const { db, call } = await fixture();
  try {
    const category = (await call('POST', '/categories', { name: 'Retail goods' }, manager)).category;
    await assert.rejects(call('POST', '/categories', { name: 'retail goods' }, manager), failure('DUPLICATE_CATEGORY'));
    await assert.rejects(call('POST', '/categories', { name: 'Cashier forbidden' }, cashier), failure('FORBIDDEN', 403));
    const first = (await call('POST', '/menu', product('Water', { categoryId: category.id, barcode: '47900001', sku: 'water-01' }), manager)).item as MenuItem;
    assert.equal(first.sku, 'WATER-01');
    const updated = (await call('PATCH', `/menu/${first.id}`, { price: 17000 }, manager)).item as MenuItem;
    assert.equal(updated.cost, 5000);
    assert.equal(updated.description, 'Original product details');
    assert.equal(updated.preparationMinutes, 12);
    const second = (await call('POST', '/menu', product('Juice'), manager)).item as MenuItem;
    await assert.rejects(call('PATCH', `/menu/${second.id}`, { barcode: '47900001' }, manager), failure('DUPLICATE_BARCODE'));
    await assert.rejects(call('PATCH', `/menu/${second.id}`, { sku: 'water-01' }, manager), failure('DUPLICATE_SKU'));
    await assert.rejects(call('DELETE', `/categories/${category.id}`, {}, manager), failure('CATEGORY_IN_USE'));
    await assert.rejects(call('PATCH', `/menu/${first.id}`, { price: 0 }, manager));
  } finally { await db.delete(); }
});

test('offline stock counts reject stale edits and receiving invoices updates weighted cost once', async () => {
  const { db, store, call } = await fixture();
  try {
    const menu = (await call('POST', '/menu', product('Retail pack'))).item;
    const created = await call('POST', '/inventory', { branchId: 'b1', name: 'Retail pack stock', category: 'resale', unit: 'packs', quantity: 2, minimum: 1, unitCost: 100, menuItemId: menu.id });
    assert.equal(created.item.quantity, 2);
    await assert.rejects(call('PATCH', `/inventory/${created.item.id}`, { branchId: 'b1', quantity: 5, expectedQuantity: 1 }), failure('STOCK_VERSION_CONFLICT'));
    assert.equal((await store.get<InventoryItem>('inventory', created.item.id))!.quantity, 2);
    await assert.rejects(call('POST', '/inventory/adjust', { branchId: 'b1', itemId: created.item.id, quantity: -3, reason: 'Physical stock correction' }), failure('INSUFFICIENT_STOCK'));
    await assert.rejects(call('POST', '/inventory/adjust', { branchId: 'b2', itemId: created.item.id, quantity: 1, reason: 'Wrong branch' }, manager), failure('BRANCH_FORBIDDEN', 403));
    const supplier = (await call('POST', '/suppliers', { name: 'Pack supplier', phone: '0771234567', email: '' })).supplier;
    const purchase = await call('POST', '/purchases', { branchId: 'b1', supplierId: supplier.id, invoiceNumber: 'INV-1', lines: [{ itemId: created.item.id, quantity: 3, unitCost: 200 }] });
    assert.equal(purchase.purchase.total, 600);
    const received = await store.get<InventoryItem>('inventory', created.item.id);
    assert.equal(received!.quantity, 5);
    assert.equal(received!.unitCost, 160);
    assert.equal((await store.get<{ balance: number }>('supplier', supplier.id))!.balance, 600);
    await assert.rejects(call('POST', '/purchases', { branchId: 'b1', supplierId: supplier.id, invoiceNumber: 'inv-1', lines: [{ itemId: created.item.id, quantity: 3, unitCost: 200 }] }), failure('DUPLICATE_INVOICE'));
    assert.equal((await store.get<InventoryItem>('inventory', created.item.id))!.quantity, 5);
    assert.equal((await store.list('purchase')).length, 1);
    const patched = await call('PATCH', `/inventory/${created.item.id}`, { branchId: 'b1', quantity: 4, expectedQuantity: 5, minimum: 2, unitCost: 175, reason: 'Counted stock' });
    assert.equal(patched.item.quantity, 4);
    assert.equal(patched.item.minimum, 2);
    assert.equal(patched.item.unitCost, 175);
    assert.equal((await store.list('movement')).length, 3);
  } finally { await db.delete(); }
});

test('offline product alerts default to five while explicit thresholds and zero survive partial edits', async () => {
  const { db, call } = await fixture();
  try {
    const defaults = (await call('POST', '/menu', product('Default alert product'))).item as MenuItem;
    assert.equal(defaults.reorderLevel, 5);
    const defaultStock = await call('POST', '/inventory', { branchId: 'b1', name: 'Default alert stock', category: 'resale', unit: 'pcs', unitCost: 100, menuItemId: defaults.id });
    assert.equal(defaultStock.item.minimum, 5);

    const custom = (await call('POST', '/menu', product('Custom alert product', { reorderLevel: 12 }))).item as MenuItem;
    const partial = (await call('PATCH', `/menu/${custom.id}`, { price: 17000 })).item as MenuItem;
    assert.equal(partial.reorderLevel, 12);
    const customStock = await call('POST', '/inventory', { branchId: 'b1', name: 'Custom alert stock', category: 'prepared', unit: 'portions', unitCost: 100, menuItemId: custom.id });
    assert.equal(customStock.item.minimum, 12);

    const zero = (await call('POST', '/menu', product('Zero alert product', { reorderLevel: 0 }))).item as MenuItem;
    assert.equal((await call('PATCH', `/menu/${zero.id}`, { cost: 4000 })).item.reorderLevel, 0);
    const zeroStock = await call('POST', '/inventory', { branchId: 'b1', name: 'Zero alert stock', category: 'resale', unit: 'pcs', unitCost: 100, menuItemId: zero.id, minimum: 0 });
    assert.equal(zeroStock.item.minimum, 0);
    const ingredient = await call('POST', '/inventory', { branchId: 'b1', name: 'Unlinked flour', category: 'ingredient', unit: 'kg', unitCost: 100 });
    assert.equal(ingredient.item.minimum, 0);
  } finally { await db.delete(); }
});

test('offline production rolls back every ingredient and movement when one ingredient is insufficient', async () => {
  const { db, store, call } = await fixture();
  try {
    const menu = (await call('POST', '/menu', product('Rice bowl'))).item;
    await store.put('inventory', stock('b1-rice', { unitCost: 50 }));
    await store.put('inventory', stock('b1-chicken', { quantity: 0.1 }));
    await store.put('inventory', stock('b1-portions', { category: 'prepared', unit: 'portions', quantity: 2, menuItemId: menu.id }));
    await call('PUT', `/menu/${menu.id}/recipe`, { ingredients: [{ key: 'rice', quantity: 0.2 }, { key: 'chicken', quantity: 0.15 }] });
    await assert.rejects(call('POST', '/production', { branchId: 'b1', menuItemId: menu.id, quantity: 2, note: 'Lunch batch' }), failure('INSUFFICIENT_STOCK'));
    assert.equal((await store.get<InventoryItem>('inventory', 'b1-rice'))!.quantity, 10);
    assert.equal((await store.get<InventoryItem>('inventory', 'b1-portions'))!.quantity, 2);
    assert.equal((await store.list('movement')).length, 0);
    assert.equal((await store.list('production')).length, 0);
    await store.put('inventory', stock('b1-chicken'));
    const result = await call('POST', '/production', { branchId: 'b1', menuItemId: menu.id, quantity: 2, note: 'Lunch batch' });
    assert.equal(result.batch.cost, 50);
    assert.equal((await store.get<InventoryItem>('inventory', 'b1-rice'))!.quantity, 9.6);
    assert.equal((await store.get<InventoryItem>('inventory', 'b1-chicken'))!.quantity, 9.7);
    assert.equal((await store.get<InventoryItem>('inventory', 'b1-portions'))!.quantity, 4);
    assert.equal((await store.list('movement')).length, 3);
  } finally { await db.delete(); }
});

test('offline cash-flow reports use Colombo dates and avoid counting credit sales or credit refunds as cash', async () => {
  const { db, store, call } = await fixture();
  try {
    await store.put('customer', { id: 'guest', name: 'Credit guest', phone: '', email: '', visits: 1, spent: 17000, balance: 4000, points: 0, createdAt: '2026-01-02T12:00:00.000Z' });
    const order: Order = { id: 'order-1', branchId: 'b1', number: 'B1-REPORT', type: 'takeaway', tableId: null, customerId: 'guest', status: 'new', paymentStatus: 'paid', subtotal: 17000, discount: 0, tax: 0, serviceCharge: 0, total: 17000, paid: 17000, refunded: 1000, note: '', createdAt: '2026-01-02T12:00:00.000Z', updatedAt: '2026-01-02T12:00:00.000Z', createdBy: owner.id, version: 1, lines: [], payments: [
      { id: 'card', orderId: 'order-1', method: 'card', amount: 10000, received: 10000, change: 0, reference: '', createdAt: '2026-01-02T18:29:59.000Z' },
      { id: 'credit', orderId: 'order-1', method: 'credit', amount: 7000, received: 7000, change: 0, reference: '', createdAt: '2026-01-02T12:00:00.000Z' },
      { id: 'next-day', orderId: 'order-1', method: 'cash', amount: 8000, received: 8000, change: 0, reference: '', createdAt: '2026-01-02T18:30:00.000Z' },
    ] };
    await store.put('order', order);
    await store.put<CreditEntry>('credit', { id: 'collection', branchId: 'b1', customerId: 'guest', orderId: null, type: 'collection', amount: 3000, method: 'cash', reference: '=HYPERLINK("bad")', note: 'Received at counter', createdAt: '2026-01-02T12:00:00.000Z', createdBy: owner.id });
    await store.put('expense', { id: 'expense', branchId: 'b1', category: 'Supplies', description: 'Cleaning', amount: 2000, paymentMethod: 'cash', createdAt: '2026-01-02T12:00:00.000Z', createdBy: owner.id });
    await store.put('refund', { id: 'refund', branchId: 'b1', orderId: order.id, method: 'card', amount: 1000, reason: '=1+1', createdAt: '2026-01-02T12:00:00.000Z' });
    await store.put('refund', { id: 'credit-refund', branchId: 'b1', orderId: order.id, method: 'credit', amount: 1000, reason: 'Credit adjustment', createdAt: '2026-01-02T12:00:00.000Z' });
    const path = '/reports/income-expenses?branchId=b1&from=2026-01-02&to=2026-01-02';
    const report = await call('GET', `${path}&format=json`);
    assert.equal(report.income, 13000);
    assert.equal(report.expense, 3000);
    assert.equal(report.net, 10000);
    assert.equal(report.rows.length, 4);
    const csv = await call('GET', path);
    assert.ok(csv.includes("'=HYPERLINK"));
    assert.ok(csv.includes("'=1+1"));
    assert.ok(csv.includes('Credit guest · Received at counter'));
    assert.ok(csv.includes('"130.00","30.00","100.00"'));
    await assert.rejects(call('GET', path.replace('branchId=b1', 'branchId=b2'), {}, cashier), failure('BRANCH_FORBIDDEN', 403));
    await assert.rejects(call('GET', '/reports/income-expenses?from=2026-02-01&to=2026-01-01'));
  } finally { await db.delete(); }
});

test('offline staff PINs stay hashed and management rights and receipt boundaries are enforced', async () => {
  const { db, store, call } = await fixture();
  try {
    await store.put<StaffMember>('staff', { ...owner, active: true, phone: '', lastActive: null });
    await db.transaction('rw', db.tables, () => setLocalPin(store, owner.id, '1234'));
    const created = await call('POST', '/staff', { name: 'New cashier', pin: '9432', role: 'cashier', branchId: 'b1', phone: '' }, manager);
    assert.equal(created.staff.role, 'cashier');
    const credentials = await db.credentials.toArray();
    assert.equal(credentials.length, 2);
    assert.ok(credentials.every(credential => credential.hash !== '9432' && credential.hash.length === 64 && !Object.hasOwn(credential, 'pin')));
    assert.ok(!JSON.stringify(await store.list('audit')).includes('9432'));
    await assert.rejects(call('POST', '/staff', { name: 'Duplicate cashier', pin: '9432', role: 'cashier', branchId: 'b1' }, manager), failure('DUPLICATE_PIN'));
    await assert.rejects(call('POST', '/staff', { name: 'Escalated manager', pin: '9687', role: 'manager', branchId: 'b1' }, manager));
    await assert.rejects(call('PATCH', '/staff/owner', { active: false }));
    await call('PATCH', `/staff/${created.staff.id}`, { active: false }, manager);
    assert.equal((await store.get<StaffMember>('staff', created.staff.id))!.active, false);
    await assert.rejects(call('PUT', '/settings', { receiptPaperWidthMm: 58, receiptContentWidthMm: 57, receiptMarginMm: 2 }));
    await assert.rejects(call('PUT', '/settings', { receiptPaperWidthMm: 58, receiptContentWidthMm: 50, receiptMarginMm: 2, receiptOffsetMm: 3 }));
    const layout = await call('PUT', '/settings', { receiptPaperWidthMm: 58, receiptContentWidthMm: 50, receiptMarginMm: 2, receiptOffsetMm: 1.5, receiptFontSize: 9 });
    assert.equal(layout.settings.receiptPaperWidthMm, 58);
    assert.equal((await store.meta<Settings>('settings'))!.receiptOffsetMm, 1.5);
    await assert.rejects(call('PUT', '/settings', { receiptFontSize: 12 }, cashier), failure('FORBIDDEN', 403));
  } finally { await db.delete(); }
});
