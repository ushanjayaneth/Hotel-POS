import 'fake-indexeddb/auto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {MenuItem, Order, Snapshot, User} from '../shared/types';
import type {OfflineCloudCommit, OfflineCloudResult, OfflineCloudState} from '../shared/offline-cloud';
import {LocalDatabase} from '../src/lib/local/db';
import {initializeLocalWorkspace} from '../src/lib/local/seed';
import {openAutomaticCloudWorkspace} from '../src/lib/cloud-sync';
import {CloudOfflineReplica, type OfflineCloudRequest} from '../src/lib/cloud-offline';
import {createMonitorHandler} from '../server/monitor/handler';
import {MemoryMonitorStore, recordKey} from '../server/monitor/store';
import {assertMediaPayload, type MediaRecord, type MediaResponse} from '../shared/media';

const id = () => crypto.randomUUID();
const owner: User = {id: 'cloud-owner', name: 'Administrator', initials: 'A', role: 'owner', branchId: null};
async function fixture(stock?: number) {
  const original = new LocalDatabase(`offline-cloud-original-${id()}`);
  await initializeLocalWorkspace({businessName: 'Three Device Shop', ownerName: 'Owner', pin: '98765432', demo: true}, original);
  if (stock !== undefined) {
    const row = (await original.records.get(['inventory', 'b1-prepared-m1']))!;
    await original.records.put({...row, value: {...row.value as object, quantity: stock}});
  }
  const store = new MemoryMonitorStore();
  const handler = createMonitorHandler({store, env: {CLOUD_POS_PIN: '98765432', CLOUD_SESSION_SECRET: 'p'.repeat(64)}});
  let cookie = '';
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), 'https://offline-pos.test');
    const headers = new Headers(init?.headers);
    headers.set('Origin', url.origin);
    if (cookie) headers.set('Cookie', cookie);
    const result = await handler(new Request(url, {...init, headers}));
    if (result.headers.has('set-cookie')) cookie = result.headers.get('set-cookie')!.split(';')[0];
    return result;
  };
  const call: OfflineCloudRequest = async <T>(action: string, body?: unknown) => {
    const result = await fetcher(`/api/cloud?action=${action}`, {method: body === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
    const data = await result.json();
    if (!result.ok) throw Object.assign(new Error(data.error), {status: result.status, code: data.code});
    return data as T;
  };
  await call('pos-login', {pin: '98765432'});
  const sourceId = (await openAutomaticCloudWorkspace({db: original, fetch: fetcher}))!;
  const dbs: LocalDatabase[] = [];
  const state = async () => (await call<Snapshot & {offlineState: OfflineCloudState}>(`bootstrap&sourceId=${sourceId}&includeOffline=1`)).offlineState;
  const device = async () => {
    const db = new LocalDatabase(`offline-cloud-device-${id()}`); dbs.push(db);
    const replica = new CloudOfflineReplica(sourceId, db);
    await replica.cache(await state(), owner);
    return replica;
  };
  return {store, sourceId, call, state, device, destroy: async () => {await Promise.all(dbs.map(db => db.delete())); await original.delete();}};
}
const order = (quantity = 1) => ({commandId: id(), branchId: 'b1', type: 'takeaway', lines: [{menuItemId: 'm1', quantity}]});

test('two real offline cashier replicas upload paid bills and partial loan repayments into one authoritative cloud business', async () => {
  const f = await fixture();
  try {
    const one = await f.device(), two = await f.device(), observer = await f.device();
    const first = await one.api<{order: Order}>('/orders', order(2), 'POST', {offline: true});
    await one.api(`/orders/${first.order.id}/payments`, {commandId: id(), expectedVersion: first.order.version, method: 'cash', amount: first.order.total, received: first.order.total}, 'POST', {offline: true});
    const customer = await two.api<{customer: {id: string}}>('/customers', {commandId: id(), name: 'Offline Customer', phone: '0771234567', email: ''}, 'POST', {offline: true});
    const second = await two.api<{order: Order}>('/orders', order(), 'POST', {offline: true});
    await two.api(`/orders/${second.order.id}/payments`, {commandId: id(), expectedVersion: second.order.version, method: 'credit', customerId: customer.customer.id, amount: second.order.total, received: second.order.total}, 'POST', {offline: true});
    await two.api(`/customers/${customer.customer.id}/collections`, {commandId: id(), branchId: 'b1', amount: 20000, method: 'cash', reference: '', note: 'Partial repayment'}, 'POST', {offline: true});
    assert.equal((await one.status()).pending, 2); assert.equal((await two.status()).pending, 4);
    const outcomes = await Promise.all([one.sync(f.call), two.sync(f.call)]);
    assert.deepEqual(outcomes.map(result => result.pending), [0, 0], JSON.stringify(outcomes));
    await observer.cache(await f.state());
    const remote = await observer.api<Snapshot>('/bootstrap');
    assert.equal(remote.orders.length, 2);
    assert.deepEqual(new Set(remote.orders.map(value => value.id)), new Set([first.order.id, second.order.id]));
    assert.deepEqual(new Set(remote.orders.map(value => value.number)), new Set([first.order.number, second.order.number]));
    assert.equal(remote.inventory.find(value => value.id === 'b1-prepared-m1')!.quantity, 47);
    assert.equal(remote.customers.find(value => value.id === customer.customer.id)!.balance, 45000);
    assert.equal(remote.creditEntries.length, 2);
    assert.equal(remote.shifts.find(value => value.status === 'open')!.expectedCash, 150000);
    assert.equal(remote.orders.reduce((sum, value) => sum + value.paid, 0), 195000);
  } finally {await f.destroy();}
});

test('two online tentative last-item sales retain cloud stock CAS and roll back the definite losing sale', async () => {
  const f = await fixture(1);
  try {
    const one = await f.device(), two = await f.device();
    const bodies = [order(), order()];
    await Promise.all([one.api('/orders', bodies[0], 'POST', {offline: false}), two.api('/orders', bodies[1], 'POST', {offline: false})]);
    const results = await Promise.all([one.sync(f.call), two.sync(f.call)]);
    assert.deepEqual(results.map(result => result.pending).sort(), [0, 1]);
    const index = results.findIndex(result => result.pending === 1);
    assert.equal(results[index].status, 409); assert.equal(results[index].code, 'INSUFFICIENT_STOCK');
    assert.equal(await [one, two][index].rollback(bodies[index].commandId), true);
    assert.equal((await [one, two][index].status()).pending, 0);
    const projection = (await f.store.get(f.sourceId))!;
    assert.equal(projection.records[recordKey('inventory', 'b1-prepared-m1')].value.quantity, 0);
    assert.equal(Object.values(projection.records).filter(row => row.kind === 'order').length, 1);
  } finally {await f.destroy();}
});

test('an actual cloud commit whose acknowledgement is lost retries with offline delivery policy without a second bill', async () => {
  const f = await fixture();
  try {
    const replica = await f.device();
    const sale = await replica.api<{order: Order}>('/orders', order(), 'POST', {offline: false});
    let lost = true;
    const lossy: OfflineCloudRequest = async <T>(action: string, body?: unknown) => {
      const result = await f.call<T>(action, body);
      if (lost) {lost = false; throw new TypeError('Connection dropped after commit');}
      return result;
    };
    assert.equal((await replica.sync(lossy)).pending, 1);
    assert.equal((await replica.sync(f.call)).pending, 0);
    const data = await f.call<Snapshot>(`bootstrap&sourceId=${f.sourceId}`);
    assert.equal(data.orders.length, 1); assert.equal(data.orders[0].id, sale.order.id); assert.equal(data.orders[0].number, sale.order.number);
    assert.equal(data.inventory.find(row => row.id === 'b1-prepared-m1')!.quantity, 49);
  } finally {await f.destroy();}
});

test('offline product creation, price edits, stock, expenses and settings sync to a second device with captured profit', async () => {
  const f = await fixture();
  try {
    const one = await f.device(), observer = await f.device();
    const category = await one.api<{category: {id: string}}>('/categories', {commandId: id(), name: 'Offline bakery', icon: 'package'}, 'POST', {offline: true});
    const product = await one.api<{item: MenuItem}>('/menu', {commandId: id(), name: 'Offline Bun', categoryId: category.category.id, price: 15000, cost: 7000, image: 'https://example.test/bun.jpg', available: true, stockMode: 'prepared', preparationMinutes: 0}, 'POST', {offline: true});
    await one.api('/inventory', {commandId: id(), branchId: 'b1', name: 'Offline Bun Stock', category: 'resale', unit: 'pcs', quantity: 20, unitCost: 7000, menuItemId: product.item.id}, 'POST', {offline: true});
    await one.api(`/menu/${product.item.id}`, {commandId: id(), price: 16000, cost: 7500}, 'PATCH', {offline: true});
    const sold = await one.api<{order: Order}>('/orders', {commandId: id(), branchId: 'b1', type: 'takeaway', lines: [{menuItemId: product.item.id, quantity: 2}]}, 'POST', {offline: true});
    await one.api(`/orders/${sold.order.id}/payments`, {commandId: id(), expectedVersion: sold.order.version, method: 'cash', amount: sold.order.total, received: sold.order.total}, 'POST', {offline: true});
    await one.api('/expenses', {commandId: id(), branchId: 'b1', category: 'Other', description: 'Offline delivery charge', amount: 1000, paymentMethod: 'cash'}, 'POST', {offline: true});
    await one.api('/settings', {commandId: id(), businessName: 'Updated Offline Shop'}, 'PUT', {offline: true});
    const uploaded = await one.sync(f.call);
    assert.equal(uploaded.pending, 0, JSON.stringify(uploaded));
    await observer.cache(await f.state());
    const remote = await observer.api<Snapshot>('/bootstrap');
    assert.equal(remote.settings.businessName, 'Updated Offline Shop');
    assert.equal(remote.menu.find(row => row.id === product.item.id)!.price, 16000);
    assert.equal(remote.inventory.find(row => row.menuItemId === product.item.id)!.quantity, 18);
    assert.equal(remote.orders[0].total - remote.orders[0].lines[0].unitCost! * 2, 18000);
    assert.equal(remote.expenses[0].amount, 1000);
    assert.equal(remote.shifts[0].expectedCash, 31000);
  } finally {await f.destroy();}
});

test('offline uploaded product photos survive reload and appear on another device after ordered cloud sync', async () => {
  const f = await fixture();
  try {
    const one = await f.device(), observer = await f.device();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
    const bytes = Buffer.concat([png, Buffer.alloc(400000 - png.length)]);
    const payload = {id: `media-${id()}`, mime: 'image/png' as const, data: bytes.toString('base64'), byteLength: bytes.length, width: 1, height: 1};
    assert.equal(assertMediaPayload(payload).byteLength, 400000);
    const uploaded = await one.api<MediaResponse>('/media', {...payload, commandId: id()}, 'POST', {offline: true});
    const product = await one.api<{item: MenuItem}>('/menu', {commandId: id(), name: 'Photo Product', categoryId: 'rice', price: 15000, cost: 7000, image: uploaded.reference, available: true, stockMode: 'untracked', preparationMinutes: 0}, 'POST', {offline: true});
    one.db.close(); await one.db.open();
    assert.equal((await one.api<{media: MediaRecord}>(`/media/${payload.id}`)).media.data, payload.data);
    const synced = await one.sync(f.call); assert.equal(synced.pending, 0, JSON.stringify(synced));
    await observer.cache(await f.state());
    const remote = await observer.api<Snapshot>('/bootstrap');
    assert.equal(remote.menu.find(value => value.id === product.item.id)!.image, uploaded.reference);
    const fetched = await f.call<{media: MediaRecord}>(`media&sourceId=${f.sourceId}&id=${payload.id}`);
    await observer.cacheMedia(fetched.media);
    assert.equal((await observer.api<{media: MediaRecord}>(`/media/${payload.id}`)).media.data, payload.data);
    assert.equal((await observer.db.records.get(['media', payload.id]))!.kind, 'media');
  } finally {await f.destroy();}
});
