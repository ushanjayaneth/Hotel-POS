import 'fake-indexeddb/auto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {CloudKind} from '../shared/cloud-monitor';
import type {MenuItem, Order, Snapshot, User} from '../shared/types';
import type {OfflineCloudCommit, OfflineCloudResult, OfflineCloudState} from '../shared/offline-cloud';
import {CloudOfflineReplica, isCloudOfflineMutation, type OfflineCloudRequest, withCloudOfflineLock} from '../src/lib/cloud-offline';
import {LocalDatabase} from '../src/lib/local/db';
import {initializeLocalWorkspace} from '../src/lib/local/seed';
import {LocalError} from '../src/lib/local/types';
import {createLocalCredential, verifyLocalPin} from '../src/lib/local/auth';
import type {MediaRecord} from '../shared/media';

const owner: User = {id: 'cloud-owner', name: 'Administrator', initials: 'A', role: 'owner', branchId: null};
const id = () => crypto.randomUUID();
const rejected = (code: string) => (error: unknown) => error instanceof LocalError && error.code === code;
async function fixture() {
  const original = new LocalDatabase(`offline-original-${id()}`), db = new LocalDatabase(`offline-replica-${id()}`), sourceId = `source-${id()}`;
  await initializeLocalWorkspace({businessName: 'Offline Shop', ownerName: 'Owner', pin: '98765432', demo: true}, original);
  const state: OfflineCloudState = {sourceId, cloudVersion: 1,
    records: (await original.records.toArray()).map(({kind, id, branchId, value}) => ({kind: kind as CloudKind, id, branchId, value: value as Record<string, unknown>})),
    metadata: {settings: (await original.metadata.get('settings'))!.value, activeBranchId: 'b1', deviceId: 'shared-server-device-id'}};
  const replica = new CloudOfflineReplica(sourceId, db);
  return {original, db, sourceId, state, replica, destroy: async () => {await db.delete(); await original.delete();}};
}
const orderBody = (commandId = id(), quantity = 2) => ({commandId, branchId: 'b1', type: 'takeaway', lines: [{menuItemId: 'm1', quantity}]});
const ack = (commit: OfflineCloudCommit, cloudVersion = 2, warnings: string[] = []): OfflineCloudResult => ({ok: true, transactionId: commit.transactionId, cloudVersion, warnings});
const request = (call: (action: string, commit: OfflineCloudCommit) => Promise<OfflineCloudResult>) => call as OfflineCloudRequest;

test('replica authentication is verified separately from cached records and never creates local PIN credentials', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.replica.session(), null);
    await assert.rejects(f.replica.api('/orders', orderBody()), rejected('UNAUTHENTICATED'));
    await f.replica.cache(f.state);
    await assert.rejects(f.replica.api('/bootstrap'), rejected('UNAUTHENTICATED'));
    await f.replica.authorize(owner);
    assert.equal((await f.replica.api<Snapshot>('/bootstrap')).user.id, owner.id);
    assert.equal(await f.db.credentials.count(), 0); assert.equal(await f.db.sessions.count(), 0);
    assert.notEqual((await f.replica.status()).deviceId, f.state.metadata.deviceId);
    await assert.rejects(f.replica.cache({...f.state, sourceId: 'another-shop'}), rejected('OFFLINE_CACHE_INVALID'));
    await f.replica.clearSession(); assert.equal(await f.replica.session(), null);
    assert.equal((await f.replica.status()).ready, true); assert.equal(await f.original.credentials.count(), 1);
  } finally {await f.destroy();}
});

test('replica bill/payment retries survive reload with exact receipt IDs and one stock movement', async () => {
  const f = await fixture();
  try {
    await f.replica.cache(f.state, owner);
    const body = orderBody();
    const [first, retry] = await Promise.all([f.replica.api<{order: Order}>('/orders', body), f.replica.api('/api/orders', body)]);
    assert.deepEqual(first, retry);
    const payment = {commandId: id(), expectedVersion: first.order.version, method: 'cash', amount: first.order.total, received: first.order.total};
    const paid = await f.replica.api<{order: Order}>(`/orders/${first.order.id}/payments`, payment);
    f.db.close(); await f.db.open(); const reopened = new CloudOfflineReplica(f.sourceId, f.db);
    assert.deepEqual(await reopened.api('/orders', body), first); assert.deepEqual(await reopened.api(`/orders/${first.order.id}/payments`, payment), paid);
    const snapshot = await reopened.api<Snapshot>('/bootstrap');
    assert.equal(snapshot.orders.length, 1); assert.equal(snapshot.orders[0].payments.length, 1);
    assert.equal(snapshot.inventory.find(row => row.id === 'b1-prepared-m1')!.quantity, 48); assert.equal(snapshot.shifts[0].expectedCash, 130000);
    const packets: OfflineCloudCommit[] = [];
    assert.equal((await reopened.sync(request(async (_action, commit) => {packets.push(commit); return ack(commit, packets.length + 1);}))).pending, 0);
    const stock = packets[0].changes.find(row => row.kind === 'inventory')!;
    assert.equal(stock.before!.quantity, 50); assert.equal(stock.after!.quantity, 48);
    assert.equal(packets[0].changes.find(row => row.kind === 'order')!.after!.id, first.order.id);
    assert.equal(packets[1].changes.find(row => row.kind === 'order')!.after!.number, first.order.number);
    assert.equal(packets[1].changes.find(row => row.kind === 'order')!.after!.paid, paid.order.paid);
    assert.equal(new Set(packets[1].changes.map(row => `${row.kind}:${row.id}`)).size, packets[1].changes.length);
    assert.equal(await f.original.records.where('kind').equals('order').count(), 0);
  } finally {await f.destroy();}
});

test('replica outbox quota failure atomically rolls back stock, bill, command and receipt sequence', async () => {
  const f = await fixture();
  const quota = (_key: string, row: {key: string}) => {if (row.key.startsWith('cloudOffline:outbox:')) throw new DOMException('Storage quota exceeded', 'QuotaExceededError');};
  try {
    await f.replica.cache(f.state, owner); f.db.metadata.hook('creating', quota);
    const body = orderBody(); await assert.rejects(f.replica.api('/orders', body), rejected('STORAGE_FULL'));
    f.db.metadata.hook('creating').unsubscribe(quota);
    assert.equal(await f.db.commands.count(), 0); assert.equal(await f.db.journal.count(), 0); assert.equal(await f.db.records.where('kind').equals('order').count(), 0);
    assert.equal(((await f.db.records.get(['inventory', 'b1-prepared-m1']))!.value as {quantity: number}).quantity, 50);
    assert.equal((await f.replica.status()).pending, 0); assert.equal(await f.db.metadata.where('key').startsWith('receipt:').count(), 0);
    await f.replica.api('/orders', body); assert.equal((await f.replica.status()).pending, 1);
  } finally {f.db.metadata.hook('creating').unsubscribe(quota); await f.destroy();}
});

test('replica hydration preserves pending bills and rejects server snapshots older than acknowledged writes', async () => {
  const f = await fixture();
  try {
    await f.replica.cache(f.state, owner); const first = await f.replica.api<{order: Order}>('/orders', orderBody());
    assert.equal(await f.replica.cache({...f.state, cloudVersion: 3}), false);
    assert.equal((await f.replica.api<Snapshot>('/bootstrap')).orders[0].id, first.order.id);
    await f.replica.sync(request(async (_action, commit) => ack(commit, 5, ['Review stock after offline sales.'])));
    assert.equal(await f.replica.cache({...f.state, cloudVersion: 4}), false);
    const latest = {...f.state, cloudVersion: 6, records: (await f.db.records.toArray()).map(({kind, id, branchId, value}) => ({kind: kind as CloudKind, id, branchId, value: value as Record<string, unknown>}))};
    assert.equal(await f.replica.cache(latest), true);
    assert.equal((await f.replica.api<Snapshot>('/bootstrap')).orders[0].number, first.order.number);
    assert.deepEqual((await f.replica.status()).warnings, ['Review stock after offline sales.']);
  } finally {await f.destroy();}
});

test('replica missing acknowledgements upgrade only delivery policy and retain the same immutable transaction', async () => {
  const f = await fixture();
  try {
    await f.replica.cache(f.state, owner); await f.replica.api('/orders', orderBody(), 'POST', {offline: false});
    let original!: OfflineCloudCommit;
    assert.equal((await f.replica.sync(request(async (_action, commit) => {original = structuredClone(commit); throw Object.assign(new Error('Network interrupted'), {status: 0});}))).pending, 1);
    assert.equal(original.offline, false);
    f.db.close(); await f.db.open(); const reopened = new CloudOfflineReplica(f.sourceId, f.db);
    assert.equal((await reopened.sync(request(async (_action, commit) => {assert.equal(commit.offline, true); assert.deepEqual({...commit, offline: false}, original); return ack(commit);}))).pending, 0);
    assert.equal((await reopened.api<Snapshot>('/bootstrap')).orders.length, 1);
  } finally {await f.destroy();}
});

test('replica definite rejection rolls back only the newest command and protects dependent payments', async () => {
  const f = await fixture();
  try {
    await f.replica.cache(f.state, owner); const body = orderBody(); await f.replica.api('/orders', body);
    const failed = await f.replica.sync(request(async () => {throw Object.assign(new Error('Insufficient stock'), {status: 409, code: 'INSUFFICIENT_STOCK'});}));
    assert.equal(failed.status, 409); assert.equal(failed.transactionId, body.commandId);
    assert.equal(await f.replica.rollback(body.commandId), true);
    assert.equal(await f.db.commands.count(), 0); assert.equal(await f.db.journal.count(), 0); assert.equal((await f.replica.status()).pending, 0);
    const first = await f.replica.api<{order: Order}>('/orders', body);
    const payment = {commandId: id(), expectedVersion: first.order.version, method: 'cash', amount: first.order.total, received: first.order.total};
    await f.replica.api(`/orders/${first.order.id}/payments`, payment);
    assert.equal(await f.replica.rollback(body.commandId), false);
    assert.equal(await f.replica.rollback(payment.commandId), true); assert.equal(await f.replica.rollback(body.commandId), true);
    assert.equal(((await f.db.records.get(['inventory', 'b1-prepared-m1']))!.value as {quantity: number}).quantity, 50);
  } finally {await f.destroy();}
});

test('replica accepts only an acknowledgement with matching transaction identity', async () => {
  const f = await fixture();
  try {
    await f.replica.cache(f.state, owner); await f.replica.api('/orders', orderBody());
    const result = await f.replica.sync(request(async (_action, commit) => ({...ack(commit), transactionId: id()})));
    assert.equal(result.pending, 1); assert.equal(result.code, 'OFFLINE_ACK_INVALID'); assert.equal(await f.db.commands.count(), 1);
  } finally {await f.destroy();}
});

test('replica devices have independent receipt namespaces even with identical server metadata', async () => {
  const f = await fixture(), otherDb = new LocalDatabase(`offline-second-${id()}`);
  try {
    const other = new CloudOfflineReplica(f.sourceId, otherDb);
    await Promise.all([f.replica.cache(f.state, owner), other.cache(f.state, owner)]);
    const [one, two] = await Promise.all([f.replica.api<{order: Order}>('/orders', orderBody()), other.api<{order: Order}>('/orders', orderBody())]);
    assert.notEqual(one.order.number, two.order.number); assert.notEqual(one.order.id, two.order.id); assert.notEqual((await f.replica.status()).deviceId, (await other.status()).deviceId);
  } finally {await otherDb.delete(); await f.destroy();}
});

test('replica source locks release on failure and unsupported account operations remain unavailable', async () => {
  const f = await fixture();
  try {
    await f.replica.cache(f.state, owner);
    assert.equal(isCloudOfflineMutation('/orders/order-id/status', 'PATCH'), true); assert.equal(isCloudOfflineMutation('/orders/order-id/status', 'POST'), false);
    await assert.rejects(f.replica.api('/staff', {commandId: id(), name: 'Staff'}), rejected('ONLINE_REQUIRED'));
    const calls: number[] = [];
    const first = withCloudOfflineLock(f.sourceId, async () => {calls.push(1); await Promise.resolve(); calls.push(2); throw new Error('Expected rejection');});
    const second = withCloudOfflineLock(f.sourceId, async () => {calls.push(3); return 4;});
    await assert.rejects(first, /Expected rejection/); assert.equal(await second, 4); assert.deepEqual(calls, [1, 2, 3]);
  } finally {await f.destroy();}
});

test('replica delivery-policy upgrade is durable, idempotent, and cannot resurrect an acknowledged command', async () => {
  const f = await fixture();
  try {
    await f.replica.cache(f.state, owner); const body = orderBody(); await f.replica.api('/orders', body, 'POST', {offline: false});
    assert.equal(await f.replica.markOffline(body.commandId), true); assert.equal(await f.replica.markOffline(body.commandId), true);
    const stored = (await f.db.metadata.get(`cloudOffline:outbox:${body.commandId}`))!.value as {commit: OfflineCloudCommit}; assert.equal(stored.commit.offline, true);
    await f.replica.sync(request(async (_action, commit) => {assert.equal(commit.offline, true); return ack(commit);}));
    assert.equal(await f.replica.markOffline(body.commandId), false); assert.equal((await f.replica.status()).pending, 0);
  } finally {await f.destroy();}
});

test('replica product creation, stock costs, selling prices, profit capture and expenses work offline after reload', async () => {
  const f = await fixture();
  try {
    await f.replica.cache(f.state, owner);
    const category = await f.replica.api<{category: {id: string}}>('/categories', {commandId: id(), name: 'Offline products', icon: 'package'});
    const product = await f.replica.api<{item: MenuItem}>('/menu', {commandId: id(), name: 'Offline Bun', categoryId: category.category.id, price: 15000, cost: 7000, image: 'https://example.test/bun.jpg', available: true, stockMode: 'prepared', preparationMinutes: 0});
    await f.replica.api('/inventory', {commandId: id(), branchId: 'b1', name: 'Offline Bun stock', category: 'resale', unit: 'pcs', quantity: 20, unitCost: 7000, menuItemId: product.item.id});
    await f.replica.api(`/menu/${product.item.id}`, {commandId: id(), price: 16000, cost: 7500}, 'PATCH');
    const sale = await f.replica.api<{order: Order}>('/orders', {commandId: id(), branchId: 'b1', type: 'takeaway', lines: [{menuItemId: product.item.id, quantity: 2}]});
    await f.replica.api(`/orders/${sale.order.id}/payments`, {commandId: id(), expectedVersion: sale.order.version, method: 'cash', amount: sale.order.total, received: sale.order.total});
    await f.replica.api('/expenses', {commandId: id(), branchId: 'b1', category: 'Other', description: 'Offline delivery charge', amount: 1000, paymentMethod: 'cash'});
    f.db.close(); await f.db.open();
    const state = await new CloudOfflineReplica(f.sourceId, f.db).api<Snapshot>('/bootstrap');
    const sold = state.orders.find(row => row.id === sale.order.id)!;
    assert.equal(sold.total, 32000); assert.equal(sold.lines[0].unitCost, 7000); assert.equal(sold.total - sold.lines[0].unitCost! * 2, 18000);
    assert.equal(state.menu.find(row => row.id === product.item.id)!.price, 16000);
    assert.equal(state.inventory.find(row => row.menuItemId === product.item.id)!.quantity, 18);
    assert.equal(state.expenses.length, 1); assert.equal(state.shifts[0].expectedCash, 31000);
  } finally {await f.destroy();}
});

test('replica settings changes capture metadata before/after and definite rollback restores both representations', async () => {
  const f = await fixture();
  try {
    await f.replica.cache(f.state, owner); const commandId = id();
    await f.replica.api('/settings', {commandId, businessName: 'Updated offline shop', taxRate: 5}, 'PUT');
    assert.equal((await f.replica.api<Snapshot>('/bootstrap')).settings.businessName, 'Updated offline shop');
    const pending = (await f.db.metadata.get(`cloudOffline:outbox:${commandId}`))!.value as {commit: OfflineCloudCommit};
    const effect = pending.commit.changes.find(row => row.kind === 'settings')!;
    assert.equal(effect.before!.businessName, 'Offline Shop'); assert.equal(effect.after!.businessName, 'Updated offline shop');
    assert.equal(await f.replica.rollback(commandId), true);
    assert.equal((await f.replica.api<Snapshot>('/bootstrap')).settings.businessName, 'Offline Shop');
    assert.equal(((await f.db.records.get(['settings', 'settings']))!.value as {businessName: string}).businessName, 'Offline Shop');
  } finally {await f.destroy();}
});

test('separately downloaded immutable photos stay available through lightweight cloud refreshes without another upload', async () => {
  const f = await fixture();
  try {
    await f.replica.cache(f.state, owner);
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
    const media: MediaRecord = {id: `media-${id()}`, mime: 'image/png', data: bytes.toString('base64'), byteLength: bytes.length, width: 1, height: 1, branchId: null, createdAt: new Date().toISOString()};
    await f.replica.cacheMedia(media);
    assert.equal((await f.replica.status()).pending, 0);
    assert.equal(await f.replica.cache({...f.state, cloudVersion: 2}), true);
    assert.equal((await f.replica.api<{media: MediaRecord}>(`/media/${media.id}`)).media.data, media.data);
    await assert.rejects(f.replica.cacheMedia({...media, width: 2}), /dimensions do not match/);
    assert.equal(await f.db.records.where('kind').equals('media').count(), 1);
  } finally {await f.destroy();}
});

test('verified offline PIN survives logout and reload, restores access, and never enters business records or queued bills', async () => {
  const f = await fixture(), pin = '45678910';
  try {
    await f.replica.cache(f.state, owner);
    await f.replica.authorizePIN(pin, owner);
    const credentials = await f.db.credentials.toArray();
    assert.equal(credentials.length, 1); assert.equal(credentials[0].algorithm, 'PBKDF2-SHA256');
    assert.equal(credentials[0].iterations, 600000); assert.notEqual(credentials[0].hash, pin);
    assert.equal(await f.replica.hasPIN(), true);
    await f.replica.clearSession(); assert.equal(await f.replica.session(), null);
    assert.equal(await f.replica.hasPIN(), true);
    f.db.close(); await f.db.open();
    const reopened = new CloudOfflineReplica(f.sourceId, f.db);
    assert.deepEqual(await reopened.signIn(pin), owner);
    await reopened.api('/orders', orderBody(), 'POST', {offline: true});
    const serialized = JSON.stringify({records: await f.db.records.toArray(), commands: await f.db.commands.toArray(), journal: await f.db.journal.toArray(), metadata: await f.db.metadata.toArray()});
    assert.equal(serialized.includes(pin), false); assert.equal(serialized.includes(credentials[0].hash), false); assert.equal(serialized.includes(credentials[0].salt), false);
    assert.equal((await reopened.api<Snapshot>('/bootstrap')).orders.length, 1);
  } finally {await f.destroy();}
});

test('cloud offline PINs accept the complete server range without widening standalone PIN policy', async () => {
  const f = await fixture();
  try {
    await f.replica.cache(f.state, owner);
    for (const pin of ['123456', '1234567890123', '1234567890123456']) {
      await f.replica.authorizePIN(pin, owner); await f.replica.clearSession();
      assert.deepEqual(await f.replica.signIn(pin), owner);
      if (pin.length > 12) {
        const credential = (await f.db.credentials.toArray())[0];
        assert.equal(await verifyLocalPin(pin, credential), false);
        await assert.rejects(createLocalCredential('standalone', pin));
      }
    }
    for (const pin of ['12345', '12345678901234567']) await assert.rejects(f.replica.authorizePIN(pin, owner));
  } finally {await f.destroy();}
});

test('wrong offline PINs cannot create a session and ten attempts persistently throttle concurrent tabs', async () => {
  const f = await fixture(), pin = '45678910';
  try {
    await f.replica.cache(f.state, owner); await f.replica.authorizePIN(pin, owner); await f.replica.clearSession();
    const outcomes = await Promise.allSettled(Array.from({length: 12}, () => f.replica.signIn('99999999')));
    assert.equal(outcomes.filter(result => result.status === 'rejected' && (result.reason as LocalError).code === 'INVALID_CREDENTIALS').length, 10);
    assert.equal(outcomes.filter(result => result.status === 'rejected' && (result.reason as LocalError).code === 'RATE_LIMITED').length, 2);
    assert.equal(await f.replica.session(), null);
    f.db.close(); await f.db.open(); const reopened = new CloudOfflineReplica(f.sourceId, f.db);
    await assert.rejects(reopened.signIn(pin), rejected('RATE_LIMITED'));
    await f.db.metadata.put({key: 'cloudOffline:pinThrottle', value: {attempts: 10, until: Date.now() - 1}});
    assert.deepEqual(await reopened.signIn(pin), owner);
    assert.equal(await f.db.metadata.get('cloudOffline:pinThrottle'), undefined);
  } finally {await f.destroy();}
});

test('a cached cloud cookie or forged user metadata cannot enable offline PIN authentication', async () => {
  const f = await fixture();
  try {
    await f.replica.cache(f.state, owner); await f.replica.clearSession();
    await assert.rejects(f.replica.signIn('12345678'), rejected('OFFLINE_PIN_NOT_CONFIGURED'));
    await f.db.metadata.put({key: 'cloudOffline:pinUser', value: {version: 1, sourceId: f.sourceId, credentialId: 'cloud-offline-pin:cloud-owner', user: owner, authorizedAt: new Date().toISOString()}});
    assert.equal(await f.replica.hasPIN(), false);
    await assert.rejects(f.replica.signIn('12345678'), rejected('OFFLINE_PIN_NOT_CONFIGURED'));
    assert.equal(await f.replica.session(), null); assert.equal(await f.db.credentials.count(), 0);
    await assert.rejects(f.replica.authorizePIN('12345678', {...owner, role: 'manager'}), rejected('OFFLINE_PIN_FORBIDDEN'));
  } finally {await f.destroy();}
});

test('offline PIN authorization stays in its source and checks the cached owner identity', async () => {
  const f = await fixture(), otherDb = new LocalDatabase(`offline-pin-other-${id()}`), pin = '45678910';
  try {
    await f.replica.cache(f.state, owner); await f.replica.authorizePIN(pin, owner); await f.replica.clearSession();
    const other = new CloudOfflineReplica(`other-${id()}`, otherDb);
    await other.cache({...f.state, sourceId: other.sourceId}, owner); await other.clearSession();
    await assert.rejects(other.signIn(pin), rejected('OFFLINE_PIN_NOT_CONFIGURED'));
    assert.equal(await otherDb.credentials.count(), 0);
    const trusted = (await f.db.metadata.get('cloudOffline:pinUser'))!;
    await f.db.metadata.put({...trusted, value: {...trusted.value as object, sourceId: other.sourceId}});
    await assert.rejects(f.replica.signIn(pin), rejected('OFFLINE_PIN_NOT_CONFIGURED'));
    await f.db.metadata.put(trusted);
    const saved = trusted.value as {user: User};
    await f.db.metadata.put({...trusted, value: {...trusted.value as object, user: {...saved.user, id: 'another-owner'}}});
    await assert.rejects(f.replica.signIn(pin), rejected('OFFLINE_PIN_NOT_CONFIGURED'));
    assert.equal(await f.replica.session(), null);
  } finally {await otherDb.delete(); await f.destroy();}
});

test('reverified online PIN replaces the old offline credential and explicit revocation preserves unsynced bills', async () => {
  const f = await fixture();
  try {
    await f.replica.cache(f.state, owner); await f.replica.authorizePIN('45678910', owner);
    await f.replica.api('/orders', orderBody(), 'POST', {offline: true});
    await f.replica.authorizePIN('56789101', owner); await f.replica.clearSession();
    assert.equal(await f.db.credentials.count(), 1);
    await assert.rejects(f.replica.signIn('45678910'), rejected('INVALID_CREDENTIALS'));
    assert.deepEqual(await f.replica.signIn('56789101'), owner);
    await f.replica.invalidatePIN();
    assert.equal(await f.replica.hasPIN(), false); assert.equal(await f.replica.session(), null); assert.equal(await f.db.credentials.count(), 0);
    await assert.rejects(f.replica.signIn('56789101'), rejected('OFFLINE_PIN_NOT_CONFIGURED'));
    assert.equal((await f.replica.status()).pending, 1); assert.equal(await f.db.records.where('kind').equals('order').count(), 1);
  } finally {await f.destroy();}
});
