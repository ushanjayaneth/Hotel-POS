import {MAX_MEDIA_BYTES, assertMediaPayload, imageDimensions, type MediaInput, type MediaResponse, type ProductImageMime} from '../../shared/media';
import {api} from './api';
import {commandId} from './format';
import {localDb} from './local/db';
import {isDeviceWorkspace} from './workspace-mode';
import {sameMedia, type MediaRecord} from '../../shared/media';

const pendingFiles = new WeakMap<File, Promise<MediaInput & {commandId: string}>>();
// Base64 adds one third to the file size. This leaves room for the immutable
// record, audit event and sync envelope inside a 700 KB cloud transaction.
const uploadTargetBytes = Math.min(MAX_MEDIA_BYTES, 450_000);
const canvasBlob = (canvas: HTMLCanvasElement, quality: number) => new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('This browser could not compress the photo.')), 'image/jpeg', quality));
async function fileBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
async function preparePhoto(file: File): Promise<MediaInput & {commandId: string}> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPEG, PNG or WebP photo.');
  if (file.size > 25_000_000 || file.size < 1) throw new Error('Choose a photo smaller than 25 MB.');
  const original = new Uint8Array(await file.arrayBuffer());
  const dimensions = imageDimensions(original, file.type as ProductImageMime);
  if (dimensions.width < 1 || dimensions.height < 1 || dimensions.width * dimensions.height > 50_000_000) throw new Error('Choose a photo with fewer than 50 million pixels.');
  let source: ImageBitmap | HTMLImageElement;
  let sourceUrl: string | undefined;
  if (typeof createImageBitmap === 'function') source = await createImageBitmap(file, {imageOrientation: 'from-image'});
  else {
    sourceUrl = URL.createObjectURL(file);
    source = new Image();
    source.src = sourceUrl;
    try {await source.decode();} catch {URL.revokeObjectURL(sourceUrl); throw new Error('This photo cannot be opened. Choose another image.');}
  }
  try {
    const ratio = Math.min(1, 1600 / Math.max(source.width, source.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.width * ratio));
    canvas.height = Math.max(1, Math.round(source.height * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Photo compression is unavailable in this browser.');
    const draw = () => {context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high'; context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(source, 0, 0, canvas.width, canvas.height);};
    draw();
    let photo = await canvasBlob(canvas, 0.84);
    for (const quality of [0.72, 0.6, 0.48]) {if (photo.size <= uploadTargetBytes) break; photo = await canvasBlob(canvas, quality);}
    while (photo.size > uploadTargetBytes && canvas.width > 240 && canvas.height > 240) {
      canvas.width = Math.max(1, Math.round(canvas.width * 0.75));
      canvas.height = Math.max(1, Math.round(canvas.height * 0.75));
      draw(); photo = await canvasBlob(canvas, 0.7);
    }
    if (photo.size > uploadTargetBytes) throw new Error('The photo could not be compressed for cloud storage. Choose a smaller image.');
    const payload = {id: `media-${crypto.randomUUID()}`, mime: 'image/jpeg' as const, data: await fileBase64(photo), byteLength: photo.size, width: canvas.width, height: canvas.height};
    assertMediaPayload(payload);
    return {...payload, commandId: commandId()};
  } finally {
    if ('close' in source) source.close();
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  }
}

/** A retry of the same file uses the same immutable image and command IDs. */
export async function compressFile(file: File): Promise<string> {
  let prepared = pendingFiles.get(file);
  if (!prepared) {prepared = preparePhoto(file); pendingFiles.set(file, prepared);}
  let input: Awaited<typeof prepared>;
  try {input = await prepared;} catch (error) {pendingFiles.delete(file); throw error;}
  const response = await api<MediaResponse>('/media', input);
  if (isDeviceWorkspace()) void syncLocalProductPhotos().catch(() => {/* Original bytes remain safely in IndexedDB. */});
  return response.reference;
}

export interface PhotoUploadStatus {connected: boolean; uploaded: number; pending: number; error?: string}
let uploadJob: Promise<PhotoUploadStatus> | null = null;
let retryAfter = 0;
/** Copies photos to an authenticated same-origin backend; it never changes or deletes local records. */
export function syncLocalProductPhotos(options: {explicit?: boolean} = {}): Promise<PhotoUploadStatus> {
  if (uploadJob) return uploadJob;
  uploadJob = (async () => {
    if (!isDeviceWorkspace() || typeof window === 'undefined') return {connected: false, uploaded: 0, pending: 0};
    const origin = window.location.origin;
    const marker = (id: string) => `photo-uploaded:${origin}:${id}`;
    // Enumerate keys first: focus/online checks must not load an entire photo library.
    const keys = await localDb.records.where('kind').equals('media').primaryKeys();
    const ids = keys.map(key => key[1]);
    const acknowledgements = await localDb.metadata.bulkGet(ids.map(marker));
    const queue = ids.filter((_id, index) => !acknowledgements[index]);
    let pending = queue.length, uploaded = 0;
    if (!pending) return {connected: false, uploaded, pending};
    const offline = () => navigator.onLine === false;
    if (offline() || !options.explicit && (document.visibilityState === 'hidden' || Date.now() < retryAfter)) return {connected: false, uploaded, pending};
    let connected = false;
    try {
      const session = await fetch('/api/session', {credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(4000)});
      if (!session.ok || !session.headers.get('content-type')?.includes('application/json')) {retryAfter = Date.now() + 4000; return {connected, uploaded, pending};}
      const result = await session.json() as {user?: {role?: string}};
      if (!result.user || !['owner', 'manager'].includes(result.user.role ?? '')) {retryAfter = Date.now() + 4000; return {connected, uploaded, pending};}
      connected = true;
      for (const id of queue.slice(0, 3)) {
        if (offline() || !options.explicit && document.visibilityState === 'hidden') break;
        const record = (await localDb.records.get(['media', id]))?.value as MediaRecord | undefined;
        if (!record) continue;
        const photo = assertMediaPayload(record);
        const response = await fetch('/api/media', {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...photo, commandId: `photo-upload-${photo.id}`}), signal: AbortSignal.timeout(4000)});
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('The photo backend did not acknowledge this upload. Photos remain on this device.');
        const saved = await response.json() as MediaResponse;
        if (saved.ok !== true || saved.media?.id !== photo.id || saved.media.byteLength !== photo.byteLength || saved.media.mime !== photo.mime || saved.reference !== `/api/media/${photo.id}`) throw new Error('The photo upload acknowledgement did not match. Photos remain on this device.');
        await localDb.transaction('rw', localDb.records, localDb.metadata, async () => {
          const current = (await localDb.records.get(['media', photo.id]))?.value as MediaRecord | undefined;
          if (!current || !sameMedia(current, photo)) throw new Error('The local photo changed while uploading. Try again after restoring finishes.');
          await localDb.metadata.put({key: marker(photo.id), value: {uploadedAt: new Date().toISOString(), reference: saved.reference}});
        });
        uploaded++; pending--;
      }
      retryAfter = 0;
      return {connected, uploaded, pending};
    } catch (error) {
      retryAfter = Date.now() + 4000;
      return {connected, uploaded, pending, error: error instanceof Error ? error.message : 'Photos remain on this device until the backend is available.'};
    }
  })().finally(() => {uploadJob = null;});
  return uploadJob;
}
