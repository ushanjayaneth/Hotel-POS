import {useEffect, useState, type ImgHTMLAttributes} from 'react';
import {base64ToBytes, mediaIdFromReference, type MediaRecord} from '../../shared/media';
import {localDb} from '../lib/local/db';
import {isDeviceWorkspace} from '../lib/workspace-mode';

interface CachedPhoto {url: string; users: number; accessed: number}
const cache = new Map<string, CachedPhoto>();
const pending = new Map<string, Promise<CachedPhoto | null>>();
function trimCache() {
  const unused = [...cache.entries()].filter(([, entry]) => entry.users === 0).sort((a, b) => a[1].accessed - b[1].accessed);
  while (cache.size > 32 && unused.length) {const [id, entry] = unused.shift()!; URL.revokeObjectURL(entry.url); cache.delete(id);}
}
async function photoSource(id: string): Promise<CachedPhoto | null> {
  const existing = cache.get(id);
  if (existing) return existing;
  let request = pending.get(id);
  if (!request) {
    request = (async () => {
      const record = (await localDb.records.get(['media', id]))?.value as MediaRecord | undefined;
      if (!record) return null;
      const bytes = base64ToBytes(record.data);
      const entry = {url: URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], {type: record.mime})), users: 0, accessed: Date.now()};
      cache.set(id, entry); trimCache(); return entry;
    })().finally(() => pending.delete(id));
    pending.set(id, request);
  }
  return request;
}

/** Uploaded images stay available from the device database while offline. */
export function ProductPhoto({src = '', alt = '', ...props}: ImgHTMLAttributes<HTMLImageElement>) {
  const id = mediaIdFromReference(src);
  const local = Boolean(id && (src.startsWith('local-image:') || isDeviceWorkspace()));
  const [resolved, setResolved] = useState<{reference: string; url: string}>();
  useEffect(() => {
    if (!local || !id) return;
    let active = true;
    let acquired: CachedPhoto | null = null;
    void photoSource(id).then(entry => {
      if (!active || !entry) return;
      entry.users++; entry.accessed = Date.now(); acquired = entry;
      setResolved({reference: src, url: entry.url});
    }).catch(() => {if (active) setResolved({reference: src, url: ''});});
    return () => {active = false; if (acquired) acquired.users = Math.max(0, acquired.users - 1); trimCache();};
  }, [src, local, id]);
  const url = local ? resolved?.reference === src ? resolved.url : '' : src;
  if (!url) return <span className={`product-photo-empty ${props.className ?? ''}`} role="img" aria-label={alt || 'No product photo'} style={props.style} />;
  return <img {...props} src={url} alt={alt} />;
}
export default ProductPhoto;
