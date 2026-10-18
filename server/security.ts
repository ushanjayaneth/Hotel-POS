import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { User, Role, StaffMember } from '../shared/types';
import { ApiError, requireThat, sha, Store } from './database';

export function setPin(store: Store, staffId: string, pin: string) {
  const salt = randomBytes(32).toString('hex');
  const hash = scryptSync(pin, salt, 64).toString('hex');
  store.db.prepare('INSERT INTO credentials(staff_id,salt,hash) VALUES(?,?,?) ON CONFLICT(staff_id) DO UPDATE SET salt=excluded.salt,hash=excluded.hash').run(staffId, salt, hash);
}
export function verifyPin(pin: string, salt: string, hash: string) {
  const attempted = scryptSync(pin, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return attempted.length === expected.length && timingSafeEqual(attempted, expected);
}
export function asUser(staff: StaffMember): User { return { id: staff.id, name: staff.name, role: staff.role, branchId: staff.branchId, initials: staff.initials }; }
export function sessionUser(store: Store, request: FastifyRequest) {
  const token = request.cookies.demo_hotel_session;
  if (!token) return undefined;
  const session = store.db.prepare('SELECT staff_id,expires_at FROM sessions WHERE token_hash=?').get(sha(token)) as {staff_id: string;expires_at: number} | undefined;
  if (!session || session.expires_at < Date.now()) return undefined;
  const staff = store.get<StaffMember>('staff', session.staff_id);
  return staff?.active ? asUser(staff) : undefined;
}
export function authenticate(store: Store, request: FastifyRequest): User {
  const user = sessionUser(store, request);
  if (!user) throw new ApiError(401, 'Please sign in to continue.', 'UNAUTHENTICATED');
  return user;
}
export function permit(user: User, roles: Role[]) { requireThat(roles.includes(user.role), 'Your role does not have permission for this action.', 403, 'FORBIDDEN'); }
export function branchScope(store: Store, user: User, branchId: string) {
  requireThat(store.get('branch', branchId), 'Branch not found.', 404);
  requireThat(user.role === 'owner' || user.branchId === branchId, 'This branch is outside your permissions.', 403, 'BRANCH_FORBIDDEN');
  return branchId;
}
