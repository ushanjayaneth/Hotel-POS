import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getDatabase, type Database } from 'firebase-admin/database';
import { createHash } from 'node:crypto';
import type { CloudChange, CloudSource } from '../../shared/cloud-monitor.js';

export interface Projection {
  revision: number;
  source: CloudSource;
  records: Record<string, CloudChange>;
  metadata: Record<string, unknown>;
  commands: Record<string, { hash: string; response: unknown }>;
  lastEvent?: { id: string; hash: string };
}
export interface MonitorStore {
  get(id: string): Promise<Projection | null>;
  list(): Promise<CloudSource[]>;
  replace(id: string, expected: number | null, next: Projection): Promise<boolean>;
  rate(key: string, limit: number, windowMs: number): Promise<boolean>;
  touch(id: string, time: string): Promise<void>;
  publish(source: CloudSource): Promise<void>;
}
export const recordKey = (kind: string, id: string) => Buffer.from(JSON.stringify([kind, id])).toString('base64url');

/** Used by integration tests; production always uses Firebase below. */
export class MemoryMonitorStore implements MonitorStore {
  readonly sources = new Map<string, Projection>();
  readonly attempts = new Map<string, { count: number; until: number }>();
  async get(id: string) { return structuredClone(this.sources.get(id) ?? null); }
  async touch(id: string, time: string) { const value = this.sources.get(id); if (value) value.source.lastSeenAt = time; }
  async publish(_source: CloudSource) { }
  async list() { return [...this.sources.values()].map(value => structuredClone(value.source)); }
  async replace(id: string, expected: number | null, next: Projection) {
    if ((this.sources.get(id)?.revision ?? null) !== expected) return false;
    this.sources.set(id, structuredClone(next)); return true;
  }
  async rate(key: string, limit: number, windowMs: number) {
    const prior = this.attempts.get(key), now = Date.now();
    const value = prior && prior.until > now ? prior : { count: 0, until: now + windowMs };
    value.count++; this.attempts.set(key, value); return value.count <= limit;
  }
}

export class FirebaseMonitorStore implements MonitorStore {
  constructor(private database: Database, private tenant: string) { }
  private root() { return this.database.ref(`hotelMonitor/${this.tenant}`); }
  async touch(id: string, time: string) { await this.root().child(`index/${id}/lastSeenAt`).set(time); }
  async publish(source: CloudSource) {
    const cleanSource: CloudSource = {
      sourceId: source.sourceId,
      workspaceId: source.workspaceId,
      businessName: source.businessName,
      deviceName: source.deviceName,
      epoch: source.epoch,
      sequence: source.sequence ?? 0,
      ready: Boolean(source.ready),
      updatedAt: source.updatedAt,
      lastSeenAt: source.lastSeenAt,
      revoked: Boolean(source.revoked),
      shared: Boolean(source.shared ?? true),
      dataVersion: Number(source.dataVersion ?? 0)
    };
    await this.root().child(`index/${source.sourceId}`).transaction(current => {
      const lastSeenAt = current?.lastSeenAt && current.lastSeenAt > cleanSource.lastSeenAt ? current.lastSeenAt : cleanSource.lastSeenAt;
      const base = current && (current.dataVersion ?? -1) > (cleanSource.dataVersion ?? 0) ? current : cleanSource;
      return {
        ...base,
        lastSeenAt,
        shared: Boolean(base.shared ?? true),
        dataVersion: Number(base.dataVersion ?? 0)
      };
    }, undefined, false);
  }
  async get(id: string) {
    const value = (await this.root().child(`sources/${id}`).get()).val();
    return value?.json ? JSON.parse(value.json) as Projection : null;
  }
  async list() {
    const values = (await this.root().child('index').get()).val() as Record<string, CloudSource> | null;
    return Object.values(values ?? {});
  }
  async replace(id: string, expected: number | null, next: Projection) {
    next.source.dataVersion = Number(next.source.dataVersion ?? 0);
    next.source.shared = Boolean(next.source.shared ?? true);
    const result = await this.root().child(`sources/${id}`).transaction(current => {
      if ((current?.revision ?? null) !== expected) return undefined;
      // JSON preserves empty arrays and null fields that RTDB would otherwise prune.
      return { revision: next.revision, json: JSON.stringify(next) };
    }, undefined, false);
    if (!result.committed) return false;
    // A replay repairs this small index after an interrupted acknowledgement.
    await this.publish(next.source);
    return true;
  }
  async rate(key: string, limit: number, windowMs: number) {
    const now = Date.now();
    const result = await this.root().child(`rate/${key}`).transaction(current => {
      const value = current && current.until > now ? current : { count: 0, until: now + windowMs };
      value.count = Math.min(limit + 1, value.count + 1); return value;
    }, undefined, false);
    return result.committed && result.snapshot.val().count <= limit;
  }
}

let cached: { key: string; store: MonitorStore } | undefined;
export function firebaseMonitorStore(env: NodeJS.ProcessEnv = process.env): MonitorStore {
  const raw = env.FIREBASE_SERVICE_ACCOUNT_JSON!;
  const service = JSON.parse(raw);
  const key = `${env.CLOUD_TENANT_ID ?? 'hotel'}:${service.project_id}:${env.FIREBASE_DATABASE_URL}`;
  if (cached?.key === key) return cached.store;
  const name = `hotel-monitor-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
  const app = getApps().find(app => app.name === name) ?? initializeApp({ credential: cert(service), databaseURL: env.FIREBASE_DATABASE_URL }, name);
  const store = new FirebaseMonitorStore(getDatabase(app), env.CLOUD_TENANT_ID ?? 'hotel');
  cached = { key, store }; return store;
}
