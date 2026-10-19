import type {FastifyInstance, FastifyRequest} from 'fastify';
import type {User} from '../shared/types';
import {assertMediaPayload, base64ToBytes, isMediaId, mediaMetadata, sameMedia, type MediaRecord, type MediaResponse} from '../shared/media';
import {ApiError, now, requireThat, type Store} from './database';
import {permit} from './security';

interface Context {store: Store; getUser: (request: FastifyRequest) => User; scoped: (user: User, branchId: string) => string; audit: (user: User, branchId: string, action: string, detail: string) => unknown}
export function registerMediaRoutes(app: FastifyInstance, {store, getUser, scoped, audit}: Context) {
  app.post('/api/media', {bodyLimit: 1_000_000}, async request => {
    const user = getUser(request); permit(user, ['owner', 'manager']);
    let input;
    try {input = assertMediaPayload(request.body);} catch (error) {throw new ApiError(400, (error as Error).message, 'INVALID_PHOTO');}
    const commandId = (request.body as {commandId?: unknown}).commandId;
    requireThat(typeof commandId === 'string' && commandId.length >= 8 && commandId.length <= 160, 'A valid photo command ID is required.');
    const branchId = scoped(user, user.branchId ?? 'b1');
    return store.command(commandId, user.id, `media.create:${input.id}`, branchId, input, (): MediaResponse => {
      const previous = store.get<MediaRecord>('media', input.id);
      requireThat(!previous || sameMedia(previous, input), 'This photo ID already belongs to a different image.', 409, 'PHOTO_CONFLICT');
      const record = previous ?? {...input, branchId: null, createdAt: now()};
      if (!previous) {store.put('media', record); audit(user, branchId, 'media.created', `${record.id} · ${record.byteLength} bytes`);}
      return {ok: true, reference: `/api/media/${record.id}`, media: mediaMetadata(record)};
    });
  });
  app.get('/api/media/:id', async (request, reply) => {
    getUser(request);
    const id = (request.params as {id: string}).id;
    requireThat(isMediaId(id), 'Photo not found.', 404);
    const record = store.get<MediaRecord>('media', id);
    requireThat(record, 'Photo not found.', 404);
    reply.header('Content-Type', record.mime).header('Content-Length', String(record.byteLength)).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, max-age=86400');
    return reply.send(Buffer.from(base64ToBytes(record.data)));
  });
}
