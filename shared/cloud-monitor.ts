/** Device-isolated read-only monitoring. Admin credentials never use this contract. */
export const CLOUD_MONITOR_PATH = '/api/cloud';
export const CLOUD_MONITOR_MAX_BYTES = 700_000;
export const CLOUD_MONITOR_KINDS = ['category', 'menu', 'recipe', 'branch', 'settings', 'inventory', 'table', 'order', 'held', 'credit', 'customer', 'supplier', 'purchase', 'production', 'expense', 'shift', 'movement', 'audit', 'staff', 'refund'] as const;
export type CloudKind = typeof CLOUD_MONITOR_KINDS[number];
export interface CloudChange {kind: CloudKind; id: string; branchId: string | null; value: Record<string, unknown>}
export interface CloudSource {
  sourceId: string;
  workspaceId: string;
  businessName: string;
  deviceName: string;
  epoch: string;
  sequence: number;
  ready: boolean;
  updatedAt: string;
  lastSeenAt: string;
  revoked: boolean;
  shared?: boolean;
  dataVersion?:number;
}
export interface CloudStatus {configured: boolean; missing: string[]}
export interface CloudEnrollment {sourceId: string; businessName: string; deviceName: string; workspaceId: string}
export interface CloudEnrollmentResult {token: string; sourceId: string; epoch: string}
export interface CloudPush {sourceId: string; epoch: string; sequence: number; eventId: string; ready: boolean; changes: CloudChange[]}
export interface CloudPushResult {sequence: number; updatedAt: string}
export interface CloudHeartbeat {sourceId: string; epoch: string}
export interface CloudSnapshot {source: CloudSource; records: CloudChange[]}
export interface CloudApiError {error: string; code: string; missing?: string[]}
