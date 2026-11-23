import { getStorageObjectContent } from '../services/storage';
import { Hono } from 'hono';
import { requireNip98AuthResolved } from '../auth';
import { decodeJson } from '../services/napplet-protocol.js';
import { NappletError, nappletOperation, verifyNappletBundle } from '../services/napplets';
import { WappManagementError } from '../services/wapp-management';

export const nappletRouter = new Hono();
const base = '/workspaces/:workspaceId/apps/:appNpub/napplets';
const routes = [
  ['get', '', 'list'], ['put', '/:nappletId', 'install'], ['get', '/:nappletId', 'get'],
  ['patch', '/:nappletId', 'audience'], ['delete', '/:nappletId', 'remove'],
  ['get', '/:nappletId/bundle', 'bundle'], ['get', '/:nappletId/releases', 'releases'],
  ['post', '/:nappletId/releases', 'publish'], ['post', '/:nappletId/releases/approve', 'approve'],
  ['post', '/:nappletId/collections', 'create_collection'], ['get', '/:nappletId/collections', 'collections'],
  ['patch', '/:nappletId/collections/:collectionId', 'collection_grants'],
  ['post', '/:nappletId/collections/:collectionId/migrations', 'migrate'],
  ['get', '/:nappletId/collections/:collectionId/records', 'records'],
  ['get', '/:nappletId/collections/:collectionId/records/:recordId', 'record'],
  ['put', '/:nappletId/collections/:collectionId/records/:recordId', 'put_record'],
  ['delete', '/:nappletId/collections/:collectionId/records/:recordId', 'delete_record'],
  ['get', '/:nappletId/collections/:collectionId/records/:recordId/history', 'history'],
] as const;
for (const [method, path, operation] of routes) {
  nappletRouter.on(method.toUpperCase(), base + path, async c => {
    c.header('Cache-Control', 'no-store');
    const auth = await requireNip98AuthResolved(c);
    if (auth instanceof Response) return auth;
    try {
      let body = {};
      if (method !== 'get') {
        // Read bounded bytes, including chunked requests without a Content-Length.
        const reader = c.req.raw.body?.getReader();
        if (!reader) throw new NappletError('json_required', 400, 'JSON body required');
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.length;
            if (size > 2 * 1024 * 1024) throw new NappletError('body_too_large', 413, 'Request exceeds 2 MiB');
            chunks.push(value);
          }
          body = decodeJson(Buffer.concat(chunks).toString('utf8'));
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object required');
        } catch (error) {
          if (error instanceof NappletError) throw error;
          throw new NappletError('invalid_json', 400, 'JSON object required');
        } finally { await reader.cancel(); }
      }
      const result = await nappletOperation({ workspaceId: c.req.param('workspaceId')!, appNpub: c.req.param('appNpub')!,
        nappletId: c.req.param('nappletId'), actorNpub: auth.userNpub }, operation, body, {
        ...c.req.query(), collectionId: c.req.param('collectionId'), recordId: c.req.param('recordId'),
      });
      if (operation === 'bundle') {
        const payload = result as any;
        const stored = await getStorageObjectContent(payload.storage_object_id);
        if (!stored || stored.size > 2 * 1024 * 1024) throw new NappletError('bundle_unavailable', 404, 'Bundle unavailable');
        const digest = verifyNappletBundle(stored.bytes, payload.installation);
        // Download bytes cannot execute in the authenticated API origin.
        c.header('Content-Type', 'application/octet-stream'); c.header('X-Content-Type-Options', 'nosniff');
        c.header('Content-Disposition', 'attachment; filename="napplet.html"');
        c.header('ETag', `"${digest}"`);
        return new Response(Buffer.from(stored.bytes), { headers: c.res.headers });
      }
      return c.json(result, method === 'post' && operation === 'create_collection' ? 201 : 200);
    } catch (error) {
      if (error instanceof NappletError || error instanceof WappManagementError) return c.json({ code: error.code, error: error.message }, error.status as any);
      console.error('Napplet request failed', error instanceof Error ? error.name : 'unknown');
      return c.json({ code: 'napplet_request_failed', error: 'Napplet request failed' }, 500);
    }
  });
}
