import type {AuditEvent, Role, User} from '../../../shared/types.js';
import type {LocalStore} from './db.js';

export interface LocalRequest {
  path: string;
  method: string;
  query: URLSearchParams;
  body: any;
  user: User;
  store: LocalStore;
}
export class LocalError extends Error {
  constructor(public status: number, message: string, public code = 'VALIDATION_ERROR') {
    super(message);
    this.name = 'LocalError';
  }
  get statusCode() {return this.status;}
}
export function localStorageError(error: unknown): Error {
  if (error instanceof LocalError) return error;
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const item = current as {name?: string; message?: string; inner?: unknown; cause?: unknown; failures?: unknown[]};
    if (item.name === 'QuotaExceededError' || /quota.*exceed|storage.*full/i.test(item.message ?? '')) {
      return new LocalError(507, 'Device storage is full. No changes were saved. Export a backup and free space before retrying.', 'STORAGE_FULL');
    }
    pending.push(item.inner, item.cause, ...(item.failures ?? []));
  }
  return error instanceof Error ? error : new LocalError(500, 'The operation could not be saved. Please try again.', 'LOCAL_STORAGE_ERROR');
}
export function requireLocal(condition: unknown, message: string, status = 400, code?: string): asserts condition {
  if (!condition) throw new LocalError(status, message, code);
}
export function permitLocal(user: User, roles: Role[]): void {
  requireLocal(roles.includes(user.role), 'Your role does not have permission for this action.', 403, 'FORBIDDEN');
}
export async function scopeLocal(store: LocalStore, user: User, branchId: string): Promise<string> {
  requireLocal(await store.get('branch', branchId), 'Branch not found.', 404, 'BRANCH_NOT_FOUND');
  requireLocal(user.role === 'owner' || user.branchId === branchId, 'This branch is outside your permissions.', 403, 'BRANCH_FORBIDDEN');
  return branchId;
}
export const now = () => new Date().toISOString();
export function uid(prefix: string): string {
  if (!globalThis.crypto?.getRandomValues) throw new LocalError(503, 'Secure device storage needs a supported HTTPS browser.', 'CRYPTO_UNAVAILABLE');
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}-${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}`;
}
export async function auditLocal(store: LocalStore, user: User, branchId: string, action: string, detail: string): Promise<AuditEvent> {
  return store.put<AuditEvent>('audit', {id: uid('audit'), branchId, action, actor: user.name, detail, createdAt: now()});
}
export function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export async function sha256(value: string): Promise<string> {
  requireLocal(globalThis.crypto?.subtle, 'Secure device storage needs HTTPS and Web Crypto support.', 503, 'CRYPTO_UNAVAILABLE');
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}

export interface LocalWorkspaceInfo {
  version: 1;
  workspaceId: string;
  deviceId: string;
  businessName: string;
  demo: boolean;
  createdAt: string;
}
