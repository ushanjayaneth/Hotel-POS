import Dexie from 'dexie';
import type {StaffMember, User} from '../../../shared/types.js';
import {localDb, LocalStore, type LocalCredential, type LocalDatabase} from './db.js';
import {LocalError, now, requireLocal, sha256, uid} from './types.js';

const iterations = 600_000;
const sessionLifetime = 12 * 60 * 60 * 1000;
const sessionTokens = new Map<string, string>();
const tokenKey = (db: LocalDatabase) => `demo-hotel-local-session:${db.name}`;
const hex = (bytes: Uint8Array) => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const unhex = (value: string) => Uint8Array.from(value.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16));

function token(db: LocalDatabase): string | undefined {
  try {return globalThis.sessionStorage?.getItem(tokenKey(db)) ?? sessionTokens.get(db.name);}
  catch {return sessionTokens.get(db.name);}
}
export function rememberLocalSession(db: LocalDatabase, value: string): void {
  sessionTokens.set(db.name, value);
  try {globalThis.sessionStorage?.setItem(tokenKey(db), value);} catch { /* Current tab remains signed in in memory. */ }
}
export function forgetLocalSession(db: LocalDatabase = localDb): void {
  sessionTokens.delete(db.name);
  try {globalThis.sessionStorage?.removeItem(tokenKey(db));} catch { /* Storage can be disabled by browser policy. */ }
}
export async function localSessionHash(db: LocalDatabase = localDb): Promise<string | null> {
  const current = token(db);
  return current ? sha256(current) : null;
}
async function derive(pin: string, salt: string, count = iterations): Promise<string> {
  requireLocal(globalThis.crypto?.subtle, 'Secure device storage needs HTTPS and Web Crypto support.', 503, 'CRYPTO_UNAVAILABLE');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name: 'PBKDF2', salt: unhex(salt), iterations: count, hash: 'SHA-256'}, key, 256);
  return hex(new Uint8Array(bits));
}
export async function createLocalCredential(staffId: string, pin: string, maxDigits: 12 | 16 = 12): Promise<LocalCredential> {
  requireLocal(/^\d{4,16}$/.test(pin) && pin.length <= maxDigits, `Use a PIN containing 4 to ${maxDigits} digits.`);
  const salt = hex(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await derive(pin, salt);
  const timestamp = now();
  return {staffId, salt, hash, iterations, algorithm: 'PBKDF2-SHA256', version: 1, createdAt: timestamp, updatedAt: timestamp};
}
export async function verifyLocalPin(pin: string, credential: LocalCredential, maxDigits: 12 | 16 = 12): Promise<boolean> {
  if (!/^\d{4,16}$/.test(pin) || pin.length > maxDigits || credential.algorithm !== 'PBKDF2-SHA256' || credential.version !== 1
    || !Number.isInteger(credential.iterations) || credential.iterations < 100_000 || credential.iterations > 2_000_000
    || !/^[a-f0-9]{64}$/.test(credential.salt) || !/^[a-f0-9]{64}$/.test(credential.hash)) return false;
  const attempted = await derive(pin, credential.salt, credential.iterations);
  let mismatch = attempted.length ^ credential.hash.length;
  for (let index = 0; index < attempted.length; index++) mismatch |= attempted.charCodeAt(index) ^ credential.hash.charCodeAt(index);
  return mismatch === 0;
}
export async function setLocalPin(store: LocalStore, staffId: string, pin: string): Promise<void> {
  // A staff route is already in the core transaction. Keep it alive while the
  // browser's asynchronous password KDF runs, so staff and PIN commit together.
  const credential = await Dexie.waitFor(createLocalCredential(staffId, pin));
  const previous = await store.db.credentials.get(staffId);
  await store.db.credentials.put({...credential, createdAt: previous?.createdAt ?? credential.createdAt});
}
export async function pinAlreadyUsed(store: LocalStore, pin: string, exceptStaffId?: string): Promise<boolean> {
  const credentials = await store.db.credentials.toArray();
  for (const credential of credentials) {
    if (credential.staffId === exceptStaffId) continue;
    if (await Dexie.waitFor(verifyLocalPin(pin, credential))) return true;
  }
  return false;
}
export async function localPinFingerprint(pin: string, workspaceId: string): Promise<string> {
  // Command deduplication must not add a fast PIN hash alongside the slow
  // credential hash. This work happens only when a PIN is being changed.
  return derive(pin, await sha256(`command-pin:${workspaceId}`));
}
export const publicLocalUser = (staff: StaffMember): User => ({id: staff.id, name: staff.name, role: staff.role, branchId: staff.branchId, initials: staff.initials});
export async function prepareLocalSession(staffId: string) {
  const sessionToken = uid('session');
  const createdAt = now();
  return {sessionToken, session: {tokenHash: await sha256(sessionToken), staffId, createdAt, expiresAt: Date.now() + sessionLifetime}};
}
export async function getLocalUser(db: LocalDatabase = localDb): Promise<User | null> {
  const currentToken = token(db);
  if (!currentToken) return null;
  const saved = await db.sessions.get(await sha256(currentToken));
  if (!saved || saved.expiresAt <= Date.now()) {forgetLocalSession(db); return null;}
  const staff = (await db.records.get(['staff', saved.staffId]))?.value as StaffMember | undefined;
  if (!staff?.active) {forgetLocalSession(db); return null;}
  return publicLocalUser(staff);
}
export async function loginLocal(pin: string, staffId?: string, db: LocalDatabase = localDb): Promise<User> {
  requireLocal(typeof pin === 'string' && /^\d{4,12}$/.test(pin), 'Enter your staff PIN.', 400);
  requireLocal(await db.metadata.get('workspace'), 'Set up this device before signing in.', 409, 'SETUP_REQUIRED');
  const throttle = (await db.metadata.get('loginThrottle'))?.value as {failures: number; until: number} | undefined;
  requireLocal(!throttle || throttle.until <= Date.now() || throttle.failures < 10, 'Too many unsuccessful sign-in attempts. Try again in 15 minutes.', 429, 'RATE_LIMITED');
  const credentials = staffId ? [await db.credentials.get(staffId)].filter((value): value is LocalCredential => !!value) : await db.credentials.toArray();
  let found: StaffMember | undefined;
  for (const credential of credentials) {
    const valid = await verifyLocalPin(pin, credential);
    const staff = (await db.records.get(['staff', credential.staffId]))?.value as StaffMember | undefined;
    if (valid && staff?.active) found = staff;
  }
  if (!found) {
    await db.transaction('rw', db.metadata, async () => {
      const current = (await db.metadata.get('loginThrottle'))?.value as {failures: number; until: number} | undefined;
      const failures = current && current.until > Date.now() ? current.failures + 1 : 1;
      await db.metadata.put({key: 'loginThrottle', value: {failures, until: current && current.until > Date.now() ? current.until : Date.now() + 15 * 60 * 1000}});
    });
    throw new LocalError(401, 'The PIN is incorrect or this account is inactive.', 'INVALID_CREDENTIALS');
  }
  const authenticated = await prepareLocalSession(found.id);
  const verifiedStaff = found;
  await db.transaction('rw', db.records, db.metadata, db.credentials, db.sessions, async () => {
    const current = (await db.records.get(['staff', verifiedStaff.id]))?.value as StaffMember | undefined;
    const credential = await db.credentials.get(verifiedStaff.id);
    const verifiedCredential = credentials.find(item => item.staffId === verifiedStaff.id);
    requireLocal(current?.active && credential?.hash === verifiedCredential?.hash, 'This account changed while signing in. Please try again.', 401, 'INVALID_CREDENTIALS');
    await db.sessions.where('expiresAt').belowOrEqual(Date.now()).delete();
    await db.sessions.put(authenticated.session);
    await db.metadata.delete('loginThrottle');
    const stored = await db.records.get(['staff', verifiedStaff.id]);
    if (stored) await db.records.put({...stored, value: {...current, lastActive: now()}, updatedAt: now()});
  });
  rememberLocalSession(db, authenticated.sessionToken);
  return publicLocalUser(verifiedStaff);
}
export async function logoutLocal(db: LocalDatabase = localDb): Promise<void> {
  const current = token(db);
  if (current) await db.sessions.delete(await sha256(current));
  forgetLocalSession(db);
}
