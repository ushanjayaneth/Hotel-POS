import {assertMediaPayload, isMediaId, mediaMetadata, sameMedia, type MediaRecord, type MediaResponse} from '../../../shared/media.js';
import {auditLocal, LocalError, now, permitLocal, requireLocal, scopeLocal, type LocalRequest} from './types.js';

export async function handleMedia({path, method, user, store, body}: LocalRequest): Promise<unknown | undefined> {
  if (path === '/media' && method === 'POST') {
    permitLocal(user, ['owner', 'manager']);
    let input;
    try {input = assertMediaPayload(body);} catch (error) {throw new LocalError(400, (error as Error).message, 'INVALID_PHOTO');}
    const branchId = await scopeLocal(store, user, user.branchId ?? 'b1');
    const previous = await store.get<MediaRecord>('media', input.id);
    requireLocal(!previous || sameMedia(previous, input), 'This photo ID already belongs to a different image.', 409, 'PHOTO_CONFLICT');
    const record: MediaRecord = previous ?? {...input, branchId: null, createdAt: now()};
    if (!previous) {await store.put('media', record); await auditLocal(store, user, branchId, 'media.created', `${record.id} · ${record.byteLength} bytes`);}
    return {ok: true, reference: `local-image:${record.id}`, media: mediaMetadata(record)} satisfies MediaResponse;
  }
  const match = /^\/media\/(media-[a-zA-Z0-9-]+)$/.exec(path);
  if (match && method === 'GET') {
    requireLocal(isMediaId(match[1]), 'Photo not found.', 404);
    const record = await store.get<MediaRecord>('media', match[1]);
    requireLocal(record, 'Photo not found.', 404);
    return {media: record};
  }
}
