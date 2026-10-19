import Dexie, {type Table} from 'dexie';

export interface LocalRecord {
  kind: string;
  id: string;
  branchId: string | null;
  value: unknown;
  createdAt: string;
  updatedAt: string;
}
export interface LocalMetadata {key: string; value: unknown}
export interface LocalCredential {
  staffId: string;
  salt: string;
  hash: string;
  iterations: number;
  algorithm: 'PBKDF2-SHA256';
  version: 1;
  createdAt: string;
  updatedAt: string;
}
export interface LocalSession {tokenHash: string; staffId: string; createdAt: string; expiresAt: number}
export interface LocalCommand {id: string; actor: string; hash: string; response: unknown; createdAt: string}
export interface LocalChange {kind: string; id: string; branchId: string | null; value: unknown}
export interface LocalJournal {
  id: string;
  sequence: number;
  commandId: string;
  actor: string;
  action: string;
  branchId: string | null;
  createdAt: string;
  changes: LocalChange[];
}

export class LocalDatabase extends Dexie {
  records!: Table<LocalRecord, [string, string]>;
  metadata!: Table<LocalMetadata, string>;
  credentials!: Table<LocalCredential, string>;
  sessions!: Table<LocalSession, string>;
  commands!: Table<LocalCommand, string>;
  journal!: Table<LocalJournal, string>;
  constructor(name = 'demo-hotel-local-workspace-v1') {
    super(name);
    this.version(1).stores({
      records: '[kind+id],kind,[kind+branchId],createdAt,updatedAt',
      metadata: 'key',
      credentials: 'staffId',
      sessions: 'tokenHash,staffId,expiresAt',
      commands: 'id,actor,createdAt',
      journal: 'id,&sequence,commandId,branchId,createdAt',
    });
  }
}

export const localDb = new LocalDatabase();

/** All business writes are made by core.ts inside one IndexedDB transaction. */
export class LocalStore {
  readonly changes: LocalChange[] = [];
  constructor(public readonly db: LocalDatabase = localDb) {}
  async get<T>(kind: string, id: string): Promise<T | undefined> {
    return (await this.db.records.get([kind, id]))?.value as T | undefined;
  }
  async list<T>(kind: string, branchId?: string): Promise<T[]> {
    const records = branchId === undefined
      ? await this.db.records.where('kind').equals(kind).toArray()
      : await this.db.records.where('[kind+branchId]').equals([kind, branchId]).toArray();
    return records.map(record => record.value as T);
  }
  async put<T extends {id: string; branchId?: string | null}>(kind: string, value: T): Promise<T> {
    const previous = await this.db.records.get([kind, value.id]);
    const updatedAt = new Date().toISOString();
    const branchId = value.branchId ?? null;
    await this.db.records.put({kind, id: value.id, branchId, value, createdAt: previous?.createdAt ?? updatedAt, updatedAt});
    this.changes.push({kind, id: value.id, branchId, value: structuredClone(value)});
    return value;
  }
  async remove(kind: string, id: string): Promise<void> {
    const previous = await this.db.records.get([kind, id]);
    await this.db.records.delete([kind, id]);
    if (previous) this.changes.push({kind, id, branchId: previous.branchId, value: {id, deleted: true}});
  }
  async meta<T = string>(key: string): Promise<T | undefined> {
    return (await this.db.metadata.get(key))?.value as T | undefined;
  }
  async setMeta(key: string, value: unknown): Promise<void> {
    await this.db.metadata.put({key, value});
    if (key === 'settings') this.changes.push({kind: 'settings', id: 'settings', branchId: null, value: structuredClone(value)});
  }
}
