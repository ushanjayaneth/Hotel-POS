import {browserDb, type Draft} from './db';

type UpdateGuard = (signal: AbortSignal) => Promise<void>;
const guards = new Set<UpdateGuard>();
const pendingDrafts = new Set<Promise<void>>();
const latestSave = new Map<string, object>();
const failedDrafts = new Map<string, Error>();

/** Keep draft writes visible even after the register page has been unmounted. */
export function saveDraftBeforeUpdate(draft: Draft): Promise<void> {
  const token = {};
  latestSave.set(draft.id, token);
  let pending: Promise<void>;
  pending = Promise.resolve().then(() => browserDb.drafts.put(draft)).then(
    () => {
      if (latestSave.get(draft.id) === token) failedDrafts.delete(draft.id);
      pendingDrafts.delete(pending);
    },
    error => {
      if (latestSave.get(draft.id) === token) {
        failedDrafts.set(draft.id, new Error('Reload stopped because a draft could not be saved. Open the register, free device storage and try again.'));
      }
      pendingDrafts.delete(pending);
      throw error;
    },
  );
  pendingDrafts.add(pending);
  return pending;
}

export function registerAppUpdateGuard(guard: UpdateGuard): () => void {
  guards.add(guard);
  return () => {guards.delete(guard);};
}

/** A failed or stalled save stops this reload attempt; it never schedules a later reload. */
export async function flushBeforeAppUpdate(timeoutMs = 3000): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('The current draft is still saving. Wait for it to finish, then click Reload again.'));
    }, timeoutMs);
  });
  const flush = async () => {
    await Promise.all([...guards].map(guard => guard(controller.signal)));
    while (pendingDrafts.size && !controller.signal.aborted) {
      await Promise.allSettled([...pendingDrafts]);
    }
    const failure = failedDrafts.values().next().value;
    if (failure) throw failure;
  };
  try {await Promise.race([flush(), timeout]);}
  finally {controller.abort();if (timer !== undefined) clearTimeout(timer);}
}

if (typeof window !== 'undefined') {
  window.addEventListener('local-workspace-restored', () => {
    latestSave.clear();
    failedDrafts.clear();
  });
}
