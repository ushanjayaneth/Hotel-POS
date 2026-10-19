import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';

export const now = () => new Date().toISOString();
export const uid = (prefix: string) => `${prefix}-${randomUUID()}`;
export class ApiError extends Error {
  constructor(public statusCode: number, message: string, public code = 'VALIDATION_ERROR') { super(message); }
}
export function requireThat(condition: unknown, message: string, status = 400, code?: string): asserts condition {
  if (!condition) throw new ApiError(status, message, code);
}
export function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export class Store {
  db: DatabaseSync;
  path: string;
  changes: { kind: string; id: string; branchId: string | null; value: unknown }[] | null = null;
  constructor(path: string) {
    this.path = path === ':memory:' ? path : resolve(path);
    if (path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,branch_id TEXT,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS records_branch ON records(kind,branch_id);
      CREATE TABLE IF NOT EXISTS credentials (staff_id TEXT PRIMARY KEY,salt TEXT NOT NULL,hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY,staff_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY,actor TEXT NOT NULL,hash TEXT NOT NULL,response TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY,branch_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at TEXT NOT NULL,synced_at TEXT);
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status,next_attempt);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      PRAGMA user_version=1;`);
    // Upgrade outbox events created before stream sequences were introduced.
    const legacy=this.db.prepare("SELECT id,payload FROM outbox WHERE json_extract(payload,'$.sequence') IS NULL ORDER BY rowid").all() as {id:string;payload:string}[];
    if(legacy.length)this.transaction(()=>{let sequence=Number(this.meta('hubSequence')??0);for(const row of legacy){const payload=JSON.parse(row.payload);payload.sequence=++sequence;this.db.prepare('UPDATE outbox SET payload=? WHERE id=?').run(JSON.stringify(payload),row.id);}this.setMeta('hubSequence',String(sequence));});
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id) as {data: string} | undefined;
    return row ? JSON.parse(row.data) as T : undefined;
  }
  list<T>(kind: string, branchId?: string): T[] {
    const rows = branchId === undefined ? this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind) : this.db.prepare('SELECT data FROM records WHERE kind=? AND branch_id=? ORDER BY rowid').all(kind, branchId);
    return rows.map(row => JSON.parse(row.data as string) as T);
  }
  put<T extends {id: string; branchId?: string | null}>(kind: string, value: T): T {
    const branchId = value.branchId ?? null;
    this.db.prepare('INSERT INTO records(kind,id,branch_id,data) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET branch_id=excluded.branch_id,data=excluded.data').run(kind, value.id, branchId, JSON.stringify(value));
    this.changes?.push({ kind, id: value.id, branchId, value });
    return value;
  }
  meta(key: string): string | undefined { return (this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as {value: string} | undefined)?.value; }
  setMeta(key: string, value: string) { this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  command<T>(commandId: string, actor: string, action: string, branchId: string, body: unknown, work: () => T): T {
    const hash = sha(stable({ action, body }));
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT actor,hash,response FROM commands WHERE id=?').get(commandId) as {actor: string;hash: string;response: string} | undefined;
      if (previous) {
        requireThat(previous.actor === actor && previous.hash === hash, 'This command ID was already used for a different operation.', 409, 'IDEMPOTENCY_CONFLICT');
        return JSON.parse(previous.response) as T;
      }
      this.changes = [];
      try {
        const response = work();
        const eventId = uid('event');
        const sequence=Number(this.meta('hubSequence')??0)+1;this.setMeta('hubSequence',String(sequence));
        this.db.prepare('INSERT INTO outbox(id,branch_id,payload,created_at) VALUES(?,?,?,?)').run(eventId, branchId, JSON.stringify({ id: eventId, commandId, branchId, sequence, action, actor, createdAt: now(), changes: this.changes }), now());
        this.db.prepare('INSERT INTO commands(id,actor,hash,response,created_at) VALUES(?,?,?,?,?)').run(commandId, actor, hash, JSON.stringify(response), now());
        return response;
      } finally { this.changes = null; }
    });
  }
  queueBaseline(branchId:string,hubId:string,endpoint:string) {
    const marker=`cloudBaseline:v2:${sha(`${hubId}:${branchId}:${endpoint}`)}`;
    if(this.meta(marker))return;
    requireThat(this.get('branch',branchId),'The configured HUB_BRANCH_ID does not exist.',500);
    const globals=new Set(['customer','supplier','staff','menu','recipe','category','media']);
    const rows=this.db.prepare('SELECT kind,id,branch_id,data FROM records ORDER BY rowid').all() as {kind:string;id:string;branch_id:string|null;data:string}[];
    const changes:{kind:string;id:string;branchId:string|null;value:Record<string,unknown>}[]=[];
    for(const row of rows) {
      const value=JSON.parse(row.data) as Record<string,unknown>;
      if(row.kind==='branch'){if(row.id===branchId)changes.push({kind:row.kind,id:row.id,branchId,value});continue;}
      if(row.branch_id!==branchId&&!globals.has(row.kind))continue;
      if(row.kind==='staff'&&value.branchId!==null&&value.branchId!==branchId)continue;
      changes.push({kind:row.kind,id:row.id,branchId:row.branch_id,value});
    }
    changes.push({kind:'settings',id:'settings',branchId:null,value:JSON.parse(this.meta('settings')!)});
    let chunk:typeof changes=[];let size=0;
    const flush=()=>{if(!chunk.length)return;const current=chunk;this.command(uid('baseline'),'system','hub.baseline',branchId,{count:current.length},()=>{this.changes!.push(...current);return {ok:true};});chunk=[];size=0;};
    for(const change of changes){const bytes=Buffer.byteLength(JSON.stringify(change));if(size+bytes>700000||chunk.length>=1000)flush();chunk.push(change);size+=bytes;}
    flush();this.setMeta(marker,now());
  }
  async backup(directory?: string) {
    const folder = resolve(directory ?? (this.path === ':memory:' ? 'data/backups' : `${dirname(this.path)}/backups`));
    mkdirSync(folder, { recursive: true });
    const filename = `demo-hotel-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.sqlite`;
    const path = resolve(folder, filename);
    await backup(this.db, path);
    const check = new DatabaseSync(path, { readOnly: true });
    try { requireThat(check.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok', 'Backup integrity check failed.', 500); } finally { check.close(); }
    const checksum = createHash('sha256').update(readFileSync(path)).digest('hex');
    writeFileSync(`${path}.sha256`, `${checksum}  ${basename(path)}\n`, 'utf8');
    this.setMeta('lastBackup', now());
    return { filename, path, checksum };
  }
  backupPath(filename: string) {
    requireThat(/^demo-hotel-[a-zA-Z0-9.-]+\.sqlite$/.test(filename), 'Invalid backup filename.');
    const path = resolve(this.path === ':memory:' ? 'data/backups' : `${dirname(this.path)}/backups`, filename);
    requireThat(existsSync(path), 'Backup not found.', 404);
    return path;
  }
  close() { this.db.close(); }
}
