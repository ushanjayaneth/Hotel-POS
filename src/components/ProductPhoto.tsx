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
function trimCache() {
  const unused = [...cache.entries()].filter(([, entry]) => entry.users === 0).sort((a, b) => a[1].accessed - b[1].accessed);
  while (cache.size > 32 && unused.length) {const [id, entry] = unused.shift()!; URL.revokeObjectURL(entry.url); cache.delete(id);}
}
async function photoSource(id: string, sourceId: string | null): Promise<CachedPhoto | null> {
  const key = `${sourceId ?? 'original-device'}:${id}`;
  const existing = cache.get(key);
  if (existing) return existing;
  let request = pending.get(key);
  if (!request) {
    request = (async () => {
      const replica = sourceId ? getCloudOfflineReplica(sourceId) : null;
      const db = replica?.db ?? localDb;
      let record = (await db.records.get(['media', id]))?.value as MediaRecord | undefined;
      if (!record && replica && sourceId && navigator.onLine !== false) {
        const response = await cloudRequest<{media: MediaRecord}>(`media&sourceId=${encodeURIComponent(sourceId)}&id=${encodeURIComponent(id)}`, undefined, {signal: AbortSignal.timeout(8000)});
        await replica.cacheMedia(response.media);
        record = response.media;
      }
      if (!record) return null;
      const bytes = base64ToBytes(record.data);
      const entry = {url: URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], {type: record.mime})), users: 0, accessed: Date.now()};
      cache.set(key, entry); trimCache(); return entry;
    })().finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return request;
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
    let acquired: CachedPhoto | null = null;
    const load = () => {
      if (acquired) return;
      void photoSource(id, sourceId).then(entry => {
        if (!active || !entry || acquired) return;
        entry.users++; entry.accessed = Date.now(); acquired = entry;
        setResolved({reference, url: entry.url});
      }).catch(() => {if (active) setResolved({reference, url: ''});});
    };
    load();
    window.addEventListener('online', load);
    // A temporary media failure may recover without a browser offline event.
    window.addEventListener('cloud-contact', load);
    return () => {active = false; window.removeEventListener('online', load); window.removeEventListener('cloud-contact', load); if (acquired) acquired.users = Math.max(0, acquired.users - 1); trimCache();};
  }, [reference, local, id, sourceId]);
  const url = local ? resolved?.reference === reference ? resolved.url : '' : src;
  if (!url) return <span className={`product-photo-empty ${props.className ?? ''}`} role="img" aria-label={alt || 'No product photo'} style={props.style} />;
  return <img {...props} src={url} alt={alt} />;
}
export default ProductPhoto;
