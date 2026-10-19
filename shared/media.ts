/** Product photos are immutable, small raster records, shared by both databases. */
export const MAX_MEDIA_BYTES = 700_000;
export const MAX_MEDIA_DIMENSION = 4096;
export type ProductImageMime = 'image/jpeg' | 'image/png' | 'image/webp';
export interface MediaInput {
  id: string;
  mime: ProductImageMime;
  data: string;
  byteLength: number;
  width: number;
  height: number;
}
export interface MediaRecord extends MediaInput {branchId: null; createdAt: string}
export interface MediaResponse {ok: true; reference: string; media: Omit<MediaRecord, 'data'>}

export const isMediaId = (value: unknown): value is string => typeof value === 'string' && /^media-[a-zA-Z0-9-]{8,100}$/.test(value);
export function isProductImageReference(value: string): boolean {
  if (/^local-image:media-[a-zA-Z0-9-]{8,100}$/.test(value) || /^\/api\/media\/media-[a-zA-Z0-9-]{8,100}$/.test(value)) return true;
  if (/^\/images\/[a-zA-Z0-9_./-]+$/.test(value) && !value.includes('..')) return true;
  try {const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password;} catch {return false;}
}
export function mediaIdFromReference(reference: string): string | null {
  const match = /^(?:local-image:|\/api\/media\/)(media-[a-zA-Z0-9-]{8,100})$/.exec(reference);
  return match?.[1] ?? null;
}
export function base64ToBytes(data: string): Uint8Array {
  if (!data || data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 || data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('The photo contains invalid or oversized base64 data.');
  const decoded = atob(data);
  if (btoa(decoded) !== data) throw new Error('The photo encoding is invalid.');
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}
const ascii = (bytes: Uint8Array, offset: number, count: number) => String.fromCharCode(...bytes.subarray(offset, offset + count));
/** Inspect raster headers before allowing them into a database or an image response. */
export function imageDimensions(bytes: Uint8Array, mime: ProductImageMime): {width: number; height: number} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png' && bytes.length >= 33 && bytes[0] === 137 && ascii(bytes, 1, 7) === 'PNG\r\n\x1a\n' && view.getUint32(8) === 13 && ascii(bytes, 12, 4) === 'IHDR') return {width: view.getUint32(16), height: view.getUint32(20)};
  if (mime === 'image/webp' && bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP' && view.getUint32(4, true) + 8 === bytes.length) {
    const kind = ascii(bytes, 12, 4);
    if (kind === 'VP8X' && (bytes[20] & 2) === 0) return {width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)};
    if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return {width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff};
    if (kind === 'VP8L' && bytes[20] === 0x2f) return {width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8), height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10)};
  }
  if (mime === 'image/jpeg' && bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    for (let offset = 2; offset + 4 < bytes.length;) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) return {height: view.getUint16(offset + 3), width: view.getUint16(offset + 5)};
      offset += size;
    }
  }
  throw new Error('Choose a valid static JPEG, PNG or WebP photo.');
}
export function assertMediaPayload(value: unknown): MediaInput {
  if (!value || typeof value !== 'object') throw new Error('The photo payload is missing.');
  const input = value as Record<string, unknown>;
  if (!isMediaId(input.id)) throw new Error('The photo ID is invalid.');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(String(input.mime))) throw new Error('Choose a JPEG, PNG or WebP photo.');
  if (typeof input.data !== 'string') throw new Error('The photo data is missing.');
  if (!Number.isInteger(input.byteLength) || Number(input.byteLength) < 1 || Number(input.byteLength) > MAX_MEDIA_BYTES) throw new Error('The compressed photo must be smaller than 700 KB.');
  for (const key of ['width', 'height']) if (!Number.isInteger(input[key]) || Number(input[key]) < 1 || Number(input[key]) > MAX_MEDIA_DIMENSION) throw new Error('The photo dimensions are invalid.');
  const bytes = base64ToBytes(input.data);
  if (bytes.length !== input.byteLength) throw new Error('The photo size does not match its contents.');
  const dimensions = imageDimensions(bytes, input.mime as ProductImageMime);
  if (dimensions.width !== input.width || dimensions.height !== input.height) throw new Error('The photo dimensions do not match its contents.');
  return {id: input.id, mime: input.mime as ProductImageMime, data: input.data, byteLength: input.byteLength as number, width: input.width as number, height: input.height as number};
}
export function sameMedia(a: MediaInput, b: MediaInput): boolean {
  return a.id === b.id && a.mime === b.mime && a.data === b.data && a.width === b.width && a.height === b.height && a.byteLength === b.byteLength;
}
export function mediaMetadata(record: MediaRecord): Omit<MediaRecord, 'data'> {const {data: _data, ...metadata} = record; return metadata;}
