import 'fake-indexeddb/auto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import Fastify from 'fastify';
import Dexie from 'dexie';
import {assertMediaPayload, base64ToBytes, imageDimensions, isProductImageReference, MAX_MEDIA_BYTES, type MediaInput, type MediaRecord} from '../shared/media';
import {registerMediaRoutes} from '../server/media';
import {ApiError, Store} from '../server/database';
import type {User} from '../shared/types';
import {LocalDatabase, LocalStore} from '../src/lib/local/db';
import {handleMedia} from '../src/lib/local/media';
import {LocalError} from '../src/lib/local/types';
import {localDb} from '../src/lib/local/db';
import {setWorkspaceMode} from '../src/lib/workspace-mode';
import {syncLocalProductPhotos} from '../src/lib/media';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
const commandId = () => crypto.randomUUID();
const input = (overrides: Partial<MediaInput> = {}) => ({id: `media-${commandId()}`, mime: 'image/png' as const, data: png.toString('base64'), byteLength: png.length, width: 1, height: 1, ...overrides});
const owner: User = {id: 'owner', name: 'Owner', role: 'owner', branchId: null, initials: 'OW'};

test('photo validation rejects active formats, mismatched content, invalid base64 and oversized records', () => {
  const photo = input(); assert.deepEqual(assertMediaPayload(photo), photo);
  assert.deepEqual(base64ToBytes(photo.data), new Uint8Array(png));
  const jpeg = new Uint8Array(readFileSync(new URL('../public/images/kottu.jpg', import.meta.url)));
  const size = imageDimensions(jpeg, 'image/jpeg'); assert.ok(size.width > 100 && size.height > 100);
  assert.throws(() => assertMediaPayload({...photo, mime: 'image/svg+xml'}), /JPEG, PNG or WebP/);
  assert.throws(() => assertMediaPayload({...photo, mime: 'image/jpeg'}), /valid static/);
  assert.throws(() => assertMediaPayload({...photo, data: ` ${photo.data}`}), /base64/);
  assert.throws(() => assertMediaPayload({...photo, data: '<script>alert(1)</script>'}), /base64/);
  assert.throws(() => assertMediaPayload({...photo, byteLength: photo.byteLength + 1}), /size does not match/);
  assert.throws(() => assertMediaPayload({...photo, width: 2}), /dimensions do not match/);
  assert.throws(() => assertMediaPayload({...photo, height: 5000}), /dimensions are invalid/);
  assert.throws(() => assertMediaPayload({...photo, byteLength: MAX_MEDIA_BYTES + 1}), /smaller than 700 KB/);
  assert.throws(() => assertMediaPayload({...photo, data: 'A'.repeat(1_000_000)}), /oversized/);
  assert.equal(isProductImageReference('javascript:alert(1)'), false);
  assert.equal(isProductImageReference('data:image/png;base64,anything'), false);
  assert.equal(isProductImageReference('https://user:password@example.com/photo.jpg'), false);
  assert.equal(isProductImageReference('/images/../secret'), false);
  assert.equal(isProductImageReference('https://example.com/photo.jpg'), true);
  assert.equal(isProductImageReference(`local-image:${photo.id}`), true);
  assert.equal(isProductImageReference(`/api/media/${photo.id}`), true);
});

test('hub photo API authenticates reads, restricts uploads, and persists immutable records with replay-safe commands', async () => {
  const app = Fastify({bodyLimit: 256 * 1024}); const store = new Store(':memory:');
  registerMediaRoutes(app, {
    store,
    getUser(request) {const role = request.headers['x-test-role']; if (!role) throw new ApiError(401, 'Sign in.'); return {...owner, role: role === 'cashier' ? 'cashier' : 'owner'};},
    scoped(_user, branchId) {return branchId;},
    audit() {},
  });
  try {
    const body = {...input(), commandId: commandId()}; const headers = {'x-test-role': 'owner'};
    assert.equal((await app.inject({method: 'POST', url: '/api/media', payload: body})).statusCode, 401);
    assert.equal((await app.inject({method: 'POST', url: '/api/media', headers: {'x-test-role': 'cashier'}, payload: body})).statusCode, 403);
    const first = await app.inject({method: 'POST', url: '/api/media', headers, payload: body}); assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().reference, `/api/media/${body.id}`); assert.equal(first.json().media.data, undefined);
    assert.deepEqual((await app.inject({method: 'POST', url: '/api/media', headers, payload: body})).json(), first.json());
    assert.equal(store.list('media').length, 1); assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM outbox').get()!.count, 1);
    assert.equal((await app.inject({url: first.json().reference})).statusCode, 401);
    const image = await app.inject({url: first.json().reference, headers: {'x-test-role': 'cashier'}});
    assert.equal(image.statusCode, 200); assert.equal(image.headers['content-type'], 'image/png'); assert.equal(image.headers['x-content-type-options'], 'nosniff'); assert.match(String(image.headers['cache-control']), /private/); assert.deepEqual(image.rawPayload, png);
    const changed = Buffer.from(png); changed[changed.length - 1] ^= 1;
    const conflict = await app.inject({method: 'POST', url: '/api/media', headers, payload: {...body, commandId: commandId(), data: changed.toString('base64')}});
    assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().code, 'PHOTO_CONFLICT');
    assert.equal(store.get<MediaRecord>('media', body.id)!.data, body.data);
    assert.equal((await app.inject({method: 'POST', url: '/api/media', headers, payload: {...body, commandId: commandId(), width: 2}})).statusCode, 400);
    const large = Buffer.concat([png, Buffer.alloc(300_000)]);
    const aboveDefault = await app.inject({method: 'POST', url: '/api/media', headers, payload: {...input(), commandId: commandId(), data: large.toString('base64'), byteLength: large.length}});
    assert.equal(aboveDefault.statusCode, 200, aboveDefault.body);
    const oversized = await app.inject({method: 'POST', url: '/api/media', headers, payload: {...body, data: 'A'.repeat(1_000_000)}}); assert.equal(oversized.statusCode, 413);
  } finally {await app.close(); store.db.close();}
});

test('device photo records survive reopening and never overwrite a different photo or acknowledge quota failure', async () => {
  const db = new LocalDatabase(`photos-${commandId()}`); await db.open();
  const store = new LocalStore(db); await store.put('branch', {id: 'b1'});
  const call = async (body: unknown, user = owner) => db.transaction('rw', db.tables, async () => await Dexie.waitFor(handleMedia({path: '/media', method: 'POST', query: new URLSearchParams(), body, user, store: new LocalStore(db)})));
  try {
    const photo = input(); const saved = await call(photo) as {reference: string}; assert.equal(saved.reference, `local-image:${photo.id}`);
    db.close(); await db.open();
    assert.equal((await new LocalStore(db).get<MediaRecord>('media', photo.id))!.data, photo.data);
    assert.deepEqual(await call(photo), saved);
    assert.equal((await new LocalStore(db).list('media')).length, 1);
    const changed = Buffer.from(png); changed[changed.length - 1] ^= 1;
    await assert.rejects(call({...photo, data: changed.toString('base64')}), error => error instanceof LocalError && error.status === 409);
    await assert.rejects(call(input(), {...owner, role: 'cashier'}), error => error instanceof LocalError && error.status === 403);
    const quota = () => {throw new DOMException('Storage full.', 'QuotaExceededError');};
    db.records.hook('creating', quota);
    const failed = input(); await assert.rejects(call(failed)); db.records.hook('creating').unsubscribe(quota);
    assert.equal(await new LocalStore(db).get('media', failed.id), undefined);
    assert.equal((await new LocalStore(db).list('audit')).length, 1);
  } finally {await db.delete();}
});

test('background uploads require an existing backend login and acknowledge only matching photos in bounded batches', async () => {
  const fetchOriginal = globalThis.fetch;
  const windowOriginal = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const documentOriginal = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const onLineOriginal = Object.getOwnPropertyDescriptor(navigator, 'onLine');
  const browserWindow = Object.assign(new EventTarget(), {location: {origin: 'https://test-hotel.example'}});
  Object.defineProperty(globalThis, 'window', {configurable: true, value: browserWindow});
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {visibilityState: 'visible'}});
  Object.defineProperty(navigator, 'onLine', {configurable: true, value: true});
  let loggedIn = false, mismatched = false, uploads = 0;
  const calls: Record<string, unknown>[] = [];
  globalThis.fetch = async (url, options) => {
    if (url === '/api/session') return Response.json({user: loggedIn ? {role: 'owner'} : null});
    assert.equal(url, '/api/media'); assert.equal(options?.credentials, 'same-origin');
    const body = JSON.parse(String(options?.body)); calls.push(body); uploads++;
    return Response.json({ok: true, reference: `/api/media/${body.id}`, media: {...body, id: mismatched ? 'media-wrong-id' : body.id, data: undefined}});
  };
  try {
    setWorkspaceMode('device'); await localDb.open();
    const store = new LocalStore(localDb);
    for (let count = 0; count < 5; count++) await store.put<MediaRecord>('media', {...input(), branchId: null, createdAt: new Date().toISOString()});
    assert.deepEqual(await syncLocalProductPhotos({explicit: true}), {connected: false, uploaded: 0, pending: 5}); assert.equal(uploads, 0);
    loggedIn = true; mismatched = true;
    const rejected = await syncLocalProductPhotos({explicit: true}); assert.equal(rejected.pending, 5); assert.equal(rejected.uploaded, 0); assert.ok(rejected.error); assert.equal(await localDb.metadata.count(), 0);
    mismatched = false;
    const job = syncLocalProductPhotos({explicit: true}); assert.equal(syncLocalProductPhotos({explicit: true}), job);
    assert.deepEqual(await job, {connected: true, uploaded: 3, pending: 2});
    assert.equal(await localDb.metadata.count(), 3); assert.equal((await localDb.records.where('kind').equals('media').toArray()).length, 5);
    assert.deepEqual(await syncLocalProductPhotos({explicit: true}), {connected: true, uploaded: 2, pending: 0}); assert.equal(await localDb.metadata.count(), 5);
    assert.ok(calls.every(call => call.commandId === `photo-upload-${call.id}`));
  } finally {
    setWorkspaceMode('hub'); globalThis.fetch = fetchOriginal; await localDb.delete();
    if (windowOriginal) Object.defineProperty(globalThis, 'window', windowOriginal); else Reflect.deleteProperty(globalThis, 'window');
    if (documentOriginal) Object.defineProperty(globalThis, 'document', documentOriginal); else Reflect.deleteProperty(globalThis, 'document');
    if (onLineOriginal) Object.defineProperty(navigator, 'onLine', onLineOriginal); else Reflect.deleteProperty(navigator, 'onLine');
  }
});
