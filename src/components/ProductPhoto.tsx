import {useEffect, useState, type ImgHTMLAttributes} from 'react';
import {base64ToBytes, mediaIdFromReference, type MediaRecord} from '../../shared/media';
import {localDb} from '../lib/local/db';
import {isDeviceWorkspace} from '../lib/workspace-mode';
import {getCloudOfflineReplica} from '../lib/cloud-offline';
import {sharedCloudSource} from '../lib/cloud-shared';
import {cloudRequest} from '../lib/cloud-sync';

interface CachedPhoto {url: string; users: number; accessed: number}
const cache = new Map<string, CachedPhoto>();
const pending = new Map<string, Promise<CachedPhoto | null>>();
const retryAfter = new Map<string, number>();
function trimCache() {
  const unused = [...cache.entries()].filter(([id, entry]) => entry.users === 0 && !pending.has(id)).sort((a, b) => a[1].accessed - b[1].accessed);
  while (cache.size > 32 && unused.length) {const [id, entry] = unused.shift()!; URL.revokeObjectURL(entry.url); cache.delete(id);}
}
async function photoSource(id: string, sourceId: string | null, retry = false): Promise<CachedPhoto | null> {
  const key = `${sourceId ?? 'original-device'}:${id}`;
  if (retry) retryAfter.delete(key);
  const existing = cache.get(key);
  if (existing) {existing.users++;return existing;}
  let request = pending.get(key);
  if (!request) {
    request = (async () => {
      const replica = sourceId ? getCloudOfflineReplica(sourceId) : null;
      const db = replica?.db ?? localDb;
      let record = (await db.records.get(['media', id]))?.value as MediaRecord | undefined;
      if (!record && replica && sourceId && navigator.onLine !== false) {
        if ((retryAfter.get(key) ?? 0) > Date.now()) return null;
        let response: {media: MediaRecord};
        try {response = await cloudRequest<{media: MediaRecord}>(`media&sourceId=${encodeURIComponent(sourceId)}&id=${encodeURIComponent(id)}`, undefined, {signal: AbortSignal.timeout(8000)});}
        catch (error) {retryAfter.set(key, Date.now() + 15000);throw error;}
        retryAfter.delete(key);
        await replica.cacheMedia(response.media);
        record = response.media;
      }
      if (!record) return null;
      const bytes = base64ToBytes(record.data);
      const entry = {url: URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], {type: record.mime})), users: 0, accessed: Date.now()};
      // Reserve consumers before trimming. A newly created 33rd photo must not
      // have its URL revoked while its first mounted consumer is still awaiting it.
      cache.set(key, entry); return entry;
    })().finally(() => pending.delete(key));
    pending.set(key, request);
  }
  const entry = await request;
  if (entry) entry.users++;
  return entry;
}

/** Uploaded images stay available from the device database while offline. */
export function ProductPhoto({src = '', alt = '', ...props}: ImgHTMLAttributes<HTMLImageElement>) {
  const id = mediaIdFromReference(src);
  const sourceId = sharedCloudSource();
  const local = Boolean(id && (sourceId || src.startsWith('local-image:') || isDeviceWorkspace()));
  const reference = `${sourceId ?? 'original-device'}:${src}`;
  const [resolved, setResolved] = useState<{reference: string; url: string}>();
  useEffect(() => {
    if (!local || !id) return;
    let active = true;
    let loading = false;
    let acquired: CachedPhoto | null = null;
    const load = (retry = false) => {
      if (acquired || loading) return;
      loading = true;
      void photoSource(id, sourceId, retry).then(entry => {
        loading = false;
        if (!entry) return;
        if (!active) {entry.users = Math.max(0, entry.users - 1);trimCache();return;}
        entry.accessed = Date.now(); acquired = entry;
        setResolved({reference, url: entry.url});
      }).catch(() => {loading = false;if (active) setResolved({reference, url: ''});});
    };
    const online = () => load(true);
    const contact = () => load();
    load();
    window.addEventListener('online', online);
    // A temporary media failure may recover without a browser offline event.
    window.addEventListener('cloud-contact', contact);
    return () => {active = false; window.removeEventListener('online', online); window.removeEventListener('cloud-contact', contact); if (acquired) acquired.users = Math.max(0, acquired.users - 1); trimCache();};
  }, [reference, local, id, sourceId]);
  const url = local ? resolved?.reference === reference ? resolved.url : '' : src;
  if (!url) return <span className={`product-photo-empty ${props.className ?? ''}`} role="img" aria-label={alt || 'No product photo'} style={props.style} />;
  return <img {...props} src={url} alt={alt} />;
}
export default ProductPhoto;
