import {ZodError} from 'zod';
import type {CloudKind} from '../../shared/cloud-monitor';
import {supportsOfflineCloudCommand, type OfflineCloudCommit, type OfflineCloudEffect, type OfflineCloudResult, type OfflineCloudState} from '../../shared/offline-cloud';
import {assertMediaPayload, sameMedia, type MediaRecord} from '../../shared/media';
import type {Snapshot, User} from '../../shared/types';
import {LocalDatabase, LocalStore} from './local/db';
import {createLocalCredential, verifyLocalPin} from './local/auth';
import {bootstrap} from './local/core';
import {handleCashier} from './local/cashier';
import {handleCatalog} from './local/catalog';
import {handleMedia} from './local/media';
import {LocalError, localStorageError, now, requireLocal, sha256, stable, uid, type LocalRequest} from './local/types';

/** A separate replica for each cloud business. It never opens the original
 * independent device database. Offline PIN hashes stay in its private credential
 * table and never enter business records, cloud snapshots or the outbox. */
export type CloudOfflineState = OfflineCloudState;
export type CloudOfflineChange = OfflineCloudEffect;
export type CloudOfflineCommit = OfflineCloudCommit;
interface PendingCommit {sequence: number; commit: CloudOfflineCommit}
interface ReplicaState {cloudVersion: number; cachedAt: string; lastSync: string | null; lastError: string; warnings?: string[]}
export interface CloudOfflineStatus {
  ready: boolean;
  pending: number;
  lastError: string;
  lastSync: string | null;
  deviceId: string | null;
  warnings: string[];
}
export type OfflineCloudRequest = <T = unknown>(action: string, body?: unknown) => Promise<T>;
export interface CloudOfflineSyncResult {
  pending: number;
  synced: number;
  failed: number;
  lastError: string;
  status?: number;
  code?: string;
  transactionId?: string;
}
const stateKey = 'cloudOffline:state';
const sessionKey = 'cloudOffline:user';
const pinUserKey = 'cloudOffline:pinUser';
const pinThrottleKey = 'cloudOffline:pinThrottle';
const pinCredentialPrefix = 'cloud-offline-pin:';
interface OfflinePINUser {version: 1; sourceId: string; credentialId: string; user: User; authorizedAt: string}
interface PINThrottle {attempts: number; until: number}
const outboxPrefix = 'cloudOffline:outbox:';
const databases = new Map<string, CloudOfflineReplica>();
const localLocks = new Map<string, Promise<void>>();

/** Includes the network acknowledgement in the lock, so a rejected online sale
 * can roll back before another tab creates a dependent local transaction. */
export async function withCloudOfflineLock<T>(sourceId: string, operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(`demo-hotel-cloud-billing-${sourceId}`, operation);
  }
  const previous = localLocks.get(sourceId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(resolve => {release = resolve;});
  localLocks.set(sourceId, next);
  await previous;
  try {return await operation();}
  finally {release(); if (localLocks.get(sourceId) === next) localLocks.delete(sourceId);}
}

function normalized(inputPath: string, body?: unknown, inputMethod?: string) {
  const url = new URL(inputPath.startsWith('/') ? inputPath : `/${inputPath}`, 'https://cloud.workspace');
  const path = (url.pathname.replace(/^\/api(?=\/|$)/, '') || '/').replace(/\/$/, '') || '/';
  return {url, path, method: (inputMethod ?? (body === undefined ? 'GET' : 'POST')).toUpperCase()};
}

/** Only validated operations supported by the cloud reconciler are queued. */
export function isCloudOfflineMutation(inputPath: string, inputMethod = 'POST'): boolean {
  const {path, method} = normalized(inputPath, {}, inputMethod);
  return supportsOfflineCloudCommand(path, method);
}

function announce(sourceId: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('cloud-offline-change', {detail: {sourceId}}));
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel('demo-hotel-cloud-offline');
    channel.postMessage({sourceId});
    channel.close();
  }
}

/** Captures the first before-image and final after-image, including records
 * written several times by payment, recipe and customer calculations. */
class EffectStore extends LocalStore {
  readonly before = new Map<string, {kind: string; id: string; branchId: string | null; value: Record<string, unknown> | null}>();
  private async remember(kind: string, id: string) {
    const key = `${kind}\u0000${id}`;
    if (this.before.has(key)) return;
    const row = await this.db.records.get([kind, id]);
    this.before.set(key, {kind, id, branchId: row?.branchId ?? null, value: row ? structuredClone(row.value) as Record<string, unknown> : null});
  }
  override async put<T extends {id: string; branchId?: string | null}>(kind: string, value: T): Promise<T> {
    await this.remember(kind, value.id);
    return super.put(kind, value);
  }
  override async remove(kind: string, id: string): Promise<void> {
    await this.remember(kind, id);
    return super.remove(kind, id);
  }
  override async setMeta(key: string, value: unknown): Promise<void> {
    if (key === 'settings') {
      const identity = 'settings\u0000settings';
      if (!this.before.has(identity)) {
        const previous = await this.db.metadata.get('settings');
        this.before.set(identity, {kind: 'settings', id: 'settings', branchId: null, value: previous ? structuredClone(previous.value) as Record<string, unknown> : null});
      }
      await super.setMeta(key, value);
      const previous = await this.db.records.get(['settings', 'settings']);
      const timestamp = now();
      await this.db.records.put({kind: 'settings', id: 'settings', branchId: null, value: structuredClone(value), createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp});
      return;
    }
    await super.setMeta(key, value);
  }
  async effects(): Promise<CloudOfflineChange[]> {
    const effects: CloudOfflineChange[] = [];
    for (const before of this.before.values()) {
      const row = await this.db.records.get([before.kind, before.id]);
      const after = row ? structuredClone(row.value) as Record<string, unknown> : null;
      if (stable(before.value) !== stable(after)) effects.push({kind: before.kind as CloudKind, id: before.id, branchId: row?.branchId ?? before.branchId, before: before.value, after});
    }
    return effects;
  }
}

export class CloudOfflineReplica {
  readonly db: LocalDatabase;
  private flushing: Promise<CloudOfflineSyncResult> | null = null;
  constructor(readonly sourceId: string, db?: LocalDatabase) {
    requireLocal(/^[A-Za-z0-9_-]{1,160}$/.test(sourceId), 'Invalid cloud workspace.', 400);
    this.db = db ?? new LocalDatabase(`demo-hotel-cloud-${sourceId}`);
  }
  private async pending(): Promise<PendingCommit[]> {
    return (await this.db.metadata.where('key').startsWith(outboxPrefix).toArray())
      .map(row => row.value as PendingCommit).sort((a, b) => a.sequence - b.sequence);
  }
  async authorize(user: User): Promise<void> {
    requireLocal(user && typeof user.id === 'string' && ['owner', 'manager', 'cashier', 'waiter', 'kitchen', 'storekeeper', 'accountant'].includes(user.role), 'Sign in to your POS first.', 401, 'UNAUTHENTICATED');
    await this.db.metadata.put({key: sessionKey, value: structuredClone(user)});
  }
  async clearSession(): Promise<void> {
    await this.db.metadata.delete(sessionKey);
    announce(this.sourceId);
  }
  async session(): Promise<User | null> {
    return (await this.db.metadata.get(sessionKey))?.value as User ?? null;
  }
  private trustedPINUser(value: unknown): OfflinePINUser | null {
    const saved = value as OfflinePINUser | undefined;
    const user = saved?.user;
    return saved?.version === 1 && saved.sourceId === this.sourceId && user?.role === 'owner'
      && typeof user.id === 'string' && saved.credentialId === `${pinCredentialPrefix}${user.id}`
      && typeof user.name === 'string' && typeof user.initials === 'string' && user.branchId === null
      ? saved : null;
  }
  /** Called only after the server has verified this exact POS PIN. A cached
   * cookie or public business snapshot alone must never create a PIN hash. */
  async authorizePIN(pin: string, user: User): Promise<void> {
    requireLocal(user?.role === 'owner' && typeof user.id === 'string' && user.id.length > 0 && user.id.length <= 160 && user.branchId === null, 'Sign in with the verified POS account first.', 403, 'OFFLINE_PIN_FORBIDDEN');
    const credentialId = `${pinCredentialPrefix}${user.id}`;
    // PBKDF2 runs before the IDB transaction; slow crypto must not auto-close it.
    requireLocal(/^\d{6,16}$/.test(pin), 'Use a staff PIN containing 6 to 16 digits.');
    const credential = await createLocalCredential(credentialId, pin, 16);
    try {
      await this.db.transaction('rw', this.db.credentials, this.db.metadata, async () => {
        const previous = this.trustedPINUser((await this.db.metadata.get(pinUserKey))?.value);
        if (previous && previous.credentialId !== credentialId) await this.db.credentials.delete(previous.credentialId);
        await this.db.credentials.put(credential);
        const value: OfflinePINUser = {version: 1, sourceId: this.sourceId, credentialId, user: structuredClone(user), authorizedAt: now()};
        await this.db.metadata.put({key: pinUserKey, value});
        await this.db.metadata.put({key: sessionKey, value: structuredClone(user)});
        await this.db.metadata.delete(pinThrottleKey);
      });
      announce(this.sourceId);
    } catch (error) {throw localStorageError(error);}
  }
  async hasPIN(): Promise<boolean> {
    return this.db.transaction('r', this.db.credentials, this.db.metadata, async () => {
      const saved = this.trustedPINUser((await this.db.metadata.get(pinUserKey))?.value);
      return Boolean(saved && await this.db.credentials.get(saved.credentialId));
    });
  }
  /** Logout locks the workspace but retains this already-verified offline PIN.
   * Revocation is explicit and preserves bills waiting for cloud upload. */
  async invalidatePIN(): Promise<void> {
    await this.db.transaction('rw', this.db.credentials, this.db.metadata, async () => {
      const saved = (await this.db.metadata.get(pinUserKey))?.value as OfflinePINUser | undefined;
      if (typeof saved?.credentialId === 'string' && saved.credentialId.startsWith(pinCredentialPrefix)) await this.db.credentials.delete(saved.credentialId);
      await this.db.metadata.bulkDelete([pinUserKey, pinThrottleKey, sessionKey]);
    });
    announce(this.sourceId);
  }
  async signIn(pin: string): Promise<User> {
    requireLocal(typeof pin === 'string' && /^\d{6,16}$/.test(pin), 'Enter your staff PIN.', 400);
    try {
      // Reserve each attempt atomically before crypto. Concurrent tabs cannot
      // start an unlimited number of guesses from the same throttle counter.
      const checked = await this.db.transaction('rw', this.db.credentials, this.db.metadata, async () => {
        const saved = this.trustedPINUser((await this.db.metadata.get(pinUserKey))?.value);
        const credential = saved ? await this.db.credentials.get(saved.credentialId) : undefined;
        requireLocal(saved && credential, 'Connect to the internet and sign in once to enable offline PIN access on this device.', 503, 'OFFLINE_PIN_NOT_CONFIGURED');
        requireLocal(await this.db.metadata.get(stateKey), 'Open your POS once while online to prepare this device for offline billing.', 409, 'OFFLINE_CACHE_MISSING');
        const current = (await this.db.metadata.get(pinThrottleKey))?.value as PINThrottle | undefined;
        const throttle = current && current.until > Date.now() ? current : {attempts: 0, until: Date.now() + 15 * 60 * 1000};
        requireLocal(throttle.attempts < 10, 'Too many unsuccessful sign-in attempts. Try again in 15 minutes, or sign in online.', 429, 'RATE_LIMITED');
        await this.db.metadata.put({key: pinThrottleKey, value: {...throttle, attempts: throttle.attempts + 1}});
        return {saved, credential};
      });
      const valid = await verifyLocalPin(pin, checked.credential, 16);
      requireLocal(valid, 'The staff PIN is incorrect.', 401, 'INVALID_CREDENTIALS');
      const user = await this.db.transaction('rw', this.db.credentials, this.db.metadata, async () => {
        const current = await this.db.credentials.get(checked.credential.staffId);
        const saved = this.trustedPINUser((await this.db.metadata.get(pinUserKey))?.value);
        requireLocal(current && stable(current) === stable(checked.credential) && saved && stable(saved) === stable(checked.saved), 'The saved POS PIN changed while signing in. Please try again.', 401, 'INVALID_CREDENTIALS');
        await this.db.metadata.put({key: sessionKey, value: structuredClone(saved.user)});
        await this.db.metadata.delete(pinThrottleKey);
        return saved.user;
      });
      announce(this.sourceId);
      return user;
    } catch (error) {throw localStorageError(error);}
  }
  /** Hydration and cashier writes serialize through the same IDB tables. A late
   * response can never replace unacknowledged bills or a newer server version. */
  async cache(state: CloudOfflineState, user?: User): Promise<boolean> {
    requireLocal(state.sourceId === this.sourceId && Number.isSafeInteger(state.cloudVersion) && state.cloudVersion >= 0 && Array.isArray(state.records), 'Invalid offline workspace response.', 409, 'OFFLINE_CACHE_INVALID');
    try {
      const applied = await this.db.transaction('rw', this.db.records, this.db.metadata, async () => {
        if (user) await this.authorize(user);
        if ((await this.pending()).length) return false;
        const previous = (await this.db.metadata.get(stateKey))?.value as ReplicaState | undefined;
        if (previous && state.cloudVersion < previous.cloudVersion) return false;
        const timestamp = now();
        const records = state.records.map(row => ({...row, value: structuredClone(row.value), createdAt: timestamp, updatedAt: timestamp}));
        const settings = state.metadata.settings ?? records.find(row => row.kind === 'settings' && row.id === 'settings')?.value;
        requireLocal(settings && records.some(row => row.kind === 'branch'), 'Cloud workspace is not ready for offline billing yet.', 409, 'OFFLINE_CACHE_INVALID');
        // Immutable photos may have been fetched separately to keep bootstrap
        // responses small. Refreshing sales must not erase those offline files.
        await this.db.records.where('kind').notEqual('media').delete();
        await this.db.records.bulkPut(records);
        await this.db.metadata.put({key: 'settings', value: structuredClone(settings)});
        const selected = (await this.db.metadata.get('activeBranchId'))?.value;
        const branchId = records.some(row => row.kind === 'branch' && row.id === selected) ? selected : state.metadata.activeBranchId ?? records.find(row => row.kind === 'branch')!.id;
        await this.db.metadata.put({key: 'activeBranchId', value: branchId});
        // A cloud metadata deviceId belongs to the server/original counter.
        // Each replica needs its own permanent ID for collision-free receipts.
        if (!await this.db.metadata.get('deviceId')) await this.db.metadata.put({key: 'deviceId', value: uid('device')});
        await this.db.metadata.put({key: stateKey, value: {cloudVersion: state.cloudVersion, cachedAt: timestamp, lastSync: previous?.lastSync ?? timestamp, lastError: '', warnings: previous?.warnings ?? []} satisfies ReplicaState});
        return true;
      });
      if (applied) announce(this.sourceId);
      return applied;
    } catch (error) {throw localStorageError(error);}
  }
  async status(): Promise<CloudOfflineStatus> {
    return this.db.transaction('r', this.db.metadata, async () => {
      const state = (await this.db.metadata.get(stateKey))?.value as ReplicaState | undefined;
      return {ready: Boolean(state), pending: (await this.pending()).length, lastError: state?.lastError ?? '', lastSync: state?.lastSync ?? null, deviceId: (await this.db.metadata.get('deviceId'))?.value as string ?? null, warnings: state?.warnings ?? []};
    });
  }
  /** Cache a verified immutable photo fetched separately from the business
   * snapshot. It is already in the cloud, so it must not create another upload. */
  async cacheMedia(record: MediaRecord): Promise<void> {
    const photo = assertMediaPayload(record);
    await this.db.transaction('rw', this.db.records, this.db.metadata, async () => {
      requireLocal(await this.session(), 'Sign in to your POS first.', 401, 'UNAUTHENTICATED');
      const current = await this.db.records.get(['media', photo.id]);
      requireLocal(!current || sameMedia(current.value as MediaRecord, photo), 'This photo ID belongs to another image.', 409, 'PHOTO_CONFLICT');
      if (!current) {
        const timestamp = now();
        await this.db.records.put({kind: 'media', id: photo.id, branchId: null, value: {...photo, branchId: null, createdAt: record.createdAt || timestamp}, createdAt: timestamp, updatedAt: timestamp});
      }
    });
  }
  private async authenticated(): Promise<User> {
    const user = await this.session();
    requireLocal(user, 'Sign in with your staff PIN while online before using this device offline.', 401, 'UNAUTHENTICATED');
    requireLocal(await this.db.metadata.get(stateKey), 'Open your POS once while online to prepare this device for offline billing.', 409, 'OFFLINE_CACHE_MISSING');
    return user;
  }
  async api<T = unknown>(inputPath: string, body?: unknown, inputMethod?: string, options: {offline?: boolean} = {}): Promise<T> {
    try {
      const {url, path, method} = normalized(inputPath, body, inputMethod);
      if (path === '/session' && method === 'GET') return {user: await this.session(), demo: false} as T;
      if (path === '/logout' && method === 'POST') {await this.clearSession(); return {ok: true} as T;}
      if (path === '/bootstrap' && method === 'GET') {
        return await this.db.transaction('r', this.db.records, this.db.metadata, async () => {
          const snapshot = await bootstrap(new LocalStore(this.db), await this.authenticated(), url.searchParams);
          const status = await this.status();
          return {...snapshot, sync: {...snapshot.sync, configured: true, pending: status.pending, hubOnline: false, lastSync: status.lastSync, lastError: status.lastError || null}, offline: true} as Snapshot & {offline: true};
        }) as T;
      }
      if (method === 'GET') return await this.db.transaction('r', this.db.records, this.db.metadata, async () => {
        const request: LocalRequest = {path, method, query: url.searchParams, body, user: await this.authenticated(), store: new LocalStore(this.db)};
        const result = await handleMedia(request) ?? await handleCashier(request) ?? await handleCatalog(request);
        requireLocal(result !== undefined, 'This action needs an internet connection.', 503, 'ONLINE_REQUIRED');
        return result;
      }) as T;
      requireLocal(isCloudOfflineMutation(path, method), 'This action needs an internet connection.', 503, 'ONLINE_REQUIRED');
      requireLocal(body === undefined || body !== null && typeof body === 'object' && !Array.isArray(body), 'Invalid request body.');
      const payload = (body ?? {}) as Record<string, unknown>;
      const commandId = payload.commandId ?? uid('command');
      requireLocal(typeof commandId === 'string' && commandId.length >= 8 && commandId.length <= 160, 'Invalid command ID.');
      // Crypto is outside the IDB transaction so the browser cannot auto-close it.
      const hash = await sha256(stable({path, method, query: [...url.searchParams.entries()].sort(), body: {...payload, commandId}}));
      const response = await this.db.transaction('rw', this.db.tables, async () => {
        const user = await this.authenticated();
        const previous = await this.db.commands.get(commandId);
        if (previous) {
          requireLocal(previous.actor === user.id && previous.hash === hash, 'This command ID was already used for a different operation.', 409, 'IDEMPOTENCY_CONFLICT');
          return previous.response;
        }
        const store = new EffectStore(this.db);
        const request: LocalRequest = {path, method, query: url.searchParams, body: {...payload, commandId}, user, store};
        const result = await handleMedia(request) ?? await handleCashier(request) ?? await handleCatalog(request);
        requireLocal(result !== undefined, 'This action needs an internet connection.', 503, 'ONLINE_REQUIRED');
        const createdAt = now(), sequence = ((await store.meta<number>('journalSequence')) ?? 0) + 1;
        const changes = await store.effects();
        const commit: CloudOfflineCommit = {sourceId: this.sourceId, deviceId: (await store.meta<string>('deviceId'))!, transactionId: commandId, createdAt, path, method, changes, offline: options.offline ?? (typeof navigator !== 'undefined' && navigator.onLine === false)};
        requireLocal(changes.length <= 1000 && new TextEncoder().encode(JSON.stringify(commit)).length <= 690_000, path === '/media' ? 'This photo is too large to sync safely. Choose a smaller photo.' : 'This transaction is too large to queue safely. Split it into smaller transactions.', 413, 'OFFLINE_PACKET_TOO_LARGE');
        await this.db.metadata.put({key: 'journalSequence', value: sequence});
        await this.db.metadata.put({key: `${outboxPrefix}${commandId}`, value: {sequence, commit} satisfies PendingCommit});
        await this.db.journal.put({id: uid('journal'), sequence, commandId, actor: user.id, action: `${method} ${path}`, branchId: typeof payload.branchId === 'string' ? payload.branchId : changes.find(change => change.branchId)?.branchId ?? user.branchId, createdAt, changes: store.changes});
        await this.db.commands.put({id: commandId, actor: user.id, hash, response: result, createdAt});
        return result;
      });
      announce(this.sourceId);
      return response as T;
    } catch (error) {
      if (error instanceof ZodError) throw new LocalError(400, error.issues.map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; '), 'VALIDATION_ERROR');
      throw localStorageError(error);
    }
  }
  /** Safe only for a definite server rejection, never a missing acknowledgement.
   * A later dependent command prevents rollback and preserves both queued bills. */
  async rollback(commandId: string): Promise<boolean> {
    const rolledBack = await this.db.transaction('rw', this.db.tables, async () => {
      const pending = (await this.db.metadata.get(`${outboxPrefix}${commandId}`))?.value as PendingCommit | undefined;
      if (!pending) return false;
      const sequence = (await this.db.metadata.get('journalSequence'))?.value;
      if (sequence !== pending.sequence) return false;
      const journal = await this.db.journal.where('commandId').equals(commandId).first();
      if (!journal || journal.sequence !== sequence) return false;
      for (const effect of pending.commit.changes) {
        if (effect.kind === 'settings' && effect.id === 'settings') {
          if (effect.before === null) await this.db.metadata.delete('settings');
          else await this.db.metadata.put({key: 'settings', value: structuredClone(effect.before)});
        }
        if (effect.before === null) await this.db.records.delete([effect.kind, effect.id]);
        else {
          const existing = await this.db.records.get([effect.kind, effect.id]);
          const timestamp = now();
          await this.db.records.put({kind: effect.kind, id: effect.id, branchId: typeof effect.before.branchId === 'string' ? effect.before.branchId : effect.branchId, value: effect.before, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp});
        }
      }
      await this.db.commands.delete(commandId);
      await this.db.journal.delete(journal.id);
      await this.db.metadata.delete(`${outboxPrefix}${commandId}`);
      await this.db.metadata.put({key: 'journalSequence', value: pending.sequence - 1});
      return true;
    });
    if (rolledBack) announce(this.sourceId);
    return rolledBack;
  }
  /** Delivery policy can be upgraded after a network failure without changing
   * the immutable business operation or its durable transaction identity. */
  async markOffline(commandId: string): Promise<boolean> {
    return this.db.transaction('rw', this.db.metadata, async () => {
      const key = `${outboxPrefix}${commandId}`;
      const row = await this.db.metadata.get(key);
      if (!row) return false;
      const pending = row.value as PendingCommit;
      if (!pending.commit.offline) await this.db.metadata.put({...row, value: {...pending, commit: {...pending.commit, offline: true}}});
      return true;
    });
  }
  async sync(request: OfflineCloudRequest): Promise<CloudOfflineSyncResult> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flush(request).finally(() => {this.flushing = null;});
    return this.flushing;
  }
  private async flush(request: OfflineCloudRequest): Promise<CloudOfflineSyncResult> {
    let synced = 0, lastError = '';
    let failure: Pick<CloudOfflineSyncResult, 'status' | 'code' | 'transactionId'> = {};
    // Do not hold an IndexedDB transaction open over a network request.
    for (;;) {
      const first = (await this.pending())[0];
      if (!first) break;
      try {
        const result = await request<OfflineCloudResult>('offline-commit', first.commit);
        requireLocal(result.ok === true && result.transactionId === first.commit.transactionId && Number.isSafeInteger(result.cloudVersion), 'The cloud did not confirm this saved bill. It remains queued on this device.', 502, 'OFFLINE_ACK_INVALID');
        await this.db.transaction('rw', this.db.metadata, async () => {
          const current = (await this.db.metadata.get(`${outboxPrefix}${first.commit.transactionId}`))?.value as PendingCommit | undefined;
          if (current) {
            const {offline: _sentPolicy, ...sent} = first.commit;
            const {offline: _currentPolicy, ...saved} = current.commit;
            requireLocal(stable(sent) === stable(saved), 'The saved transaction changed during upload. It remains queued on this device.', 409, 'OFFLINE_QUEUE_CHANGED');
          }
          await this.db.metadata.delete(`${outboxPrefix}${first.commit.transactionId}`);
          const state = (await this.db.metadata.get(stateKey))?.value as ReplicaState | undefined;
          if (state) await this.db.metadata.put({key: stateKey, value: {...state, cloudVersion: Math.max(state.cloudVersion, result.cloudVersion), lastSync: now(), lastError: '', warnings: [...new Set([...(state.warnings ?? []), ...(result.warnings ?? [])])].slice(-20)}});
        });
        synced++;
        announce(this.sourceId);
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Cloud upload is pending. Your bill is saved on this device.';
        const details = error as {status?: number; statusCode?: number; code?: string};
        const status = details.status ?? details.statusCode;
        failure = {status, code: details.code, transactionId: first.commit.transactionId};
        await this.db.transaction('rw', this.db.metadata, async () => {
          // A transport failure can hide a successful cloud commit. Keep exactly
          // the same IDs/effects and mark it as a completed offline transaction;
          // the server excludes this delivery policy from its deduplication hash.
          if (status === undefined || status === 0 || status >= 500) {
            const row = await this.db.metadata.get(`${outboxPrefix}${first.commit.transactionId}`);
            if (row) {
              const pending = row.value as PendingCommit;
              await this.db.metadata.put({...row, value: {...pending, commit: {...pending.commit, offline: true}}});
            }
          }
          const state = (await this.db.metadata.get(stateKey))?.value as ReplicaState | undefined;
          if (state) await this.db.metadata.put({key: stateKey, value: {...state, lastError}});
        });
        announce(this.sourceId);
        break; // A dependent payment must never overtake its order.
      }
    }
    return {pending: (await this.pending()).length, synced, failed: lastError ? 1 : 0, lastError, ...failure};
  }
}

export function getCloudOfflineReplica(sourceId: string): CloudOfflineReplica {
  let replica = databases.get(sourceId);
  if (!replica) {replica = new CloudOfflineReplica(sourceId); databases.set(sourceId, replica);}
  return replica;
}
export const cacheCloudState = (sourceId: string, state: CloudOfflineState, user?: User) => getCloudOfflineReplica(sourceId).cache(state, user);
export const authorizeOfflineSession = (sourceId: string, user: User) => getCloudOfflineReplica(sourceId).authorize(user);
export const clearOfflineSession = (sourceId: string) => getCloudOfflineReplica(sourceId).clearSession();
export const offlineSession = (sourceId: string) => getCloudOfflineReplica(sourceId).session();
export const authorizeOfflinePIN = (sourceId: string, pin: string, user: User) => getCloudOfflineReplica(sourceId).authorizePIN(pin, user);
export const offlineSignIn = (sourceId: string, pin: string) => getCloudOfflineReplica(sourceId).signIn(pin);
export const invalidateOfflinePIN = (sourceId: string) => getCloudOfflineReplica(sourceId).invalidatePIN();
export const hasOfflinePIN = (sourceId: string) => getCloudOfflineReplica(sourceId).hasPIN();
export const offlineApi = <T = unknown>(sourceId: string, path: string, body?: unknown, method?: string, options?: {offline?: boolean}) => getCloudOfflineReplica(sourceId).api<T>(path, body, method, options);
export const rollbackCloudCommand = (sourceId: string, commandId: string) => getCloudOfflineReplica(sourceId).rollback(commandId);
export const markCloudCommandOffline = (sourceId: string, commandId: string) => getCloudOfflineReplica(sourceId).markOffline(commandId);
export const syncCloudOutbox = (sourceId: string, request: OfflineCloudRequest) => getCloudOfflineReplica(sourceId).sync(request);
export const getOfflineStatus = (sourceId: string) => getCloudOfflineReplica(sourceId).status();
export const cacheCloudMedia = (sourceId: string, record: MediaRecord) => getCloudOfflineReplica(sourceId).cacheMedia(record);
