import { Hono } from 'hono';
import { verifyNip98AuthHeader } from '../auth';
import { inlineContentDisposition } from '../content-disposition';
import { AppStorageError, registeredAppStorage } from '../services/registered-app-storage';

export const registeredAppStorageRouter = new Hono();
const base = '/:workspaceOwnerNpub/apps/:appNpub/storage';

for (const [method, suffix, operation] of [
  ['get', '/descriptor', 'descriptor'], ['post', '/prepare', 'prepare'], ['put', '/objects/:objectId', 'upload'],
  ['post', '/objects/:objectId/complete', 'complete'], ['get', '/objects/:objectId', 'metadata'],
  ['get', '/objects/:objectId/content', 'content'], ['head', '/objects/:objectId/content', 'content'],
] as const) {
  registeredAppStorageRouter.on(method.toUpperCase(), `${base}${suffix}`, async c => {
    c.header('Cache-Control', 'private, no-store');
    // Consume the envelope with a hard bound BEFORE signature verification.
    // Content-Length is only an early hint; chunked bodies receive the same bound.
    const limit = 12 * 1024 * 1024;
    if (Number(c.req.header('content-length')) > limit) return c.json({ error: 'body_too_large', code: 'body_too_large' }, 413);
    if (['get', 'head'].includes(method) && (c.req.raw.body || Number(c.req.header('content-length')) > 0)) return c.json({ error: 'read_body_forbidden' }, 400);
    const chunks: Uint8Array[] = []; let total = 0;
    const reader = c.req.raw.body?.getReader();
    if (reader) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort!: () => void;
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => reject(new Error('body_read_aborted'));
        timer = setTimeout(() => reject(new Error('body_read_timeout')), 15_000);
        c.req.raw.signal.addEventListener('abort', abort, { once: true });
        if (c.req.raw.signal.aborted) abort();
      });
      try {
        while (true) {
          const part = await Promise.race([reader.read(), interrupted]); if (part.done) break;
          total += part.value.length;
          if (total > limit) { void reader.cancel().catch(() => {}); return c.json({ error: 'body_too_large', code: 'body_too_large' }, 413); }
          chunks.push(part.value);
        }
      } catch {
        void reader.cancel().catch(() => {});
        return c.json({ error: 'body_read_interrupted' }, 408);
      } finally { clearTimeout(timer); c.req.raw.signal.removeEventListener('abort', abort); reader.releaseLock(); }
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const signer = await verifyNip98AuthHeader(c.req.header('authorization') ?? null, c.req.raw, { rawBody });
    if (!signer) return c.json({ error: 'nip98 auth required' }, 401);
    try {
      const body = method === 'post' || method === 'put' ? (() => { try { return JSON.parse(rawBody); } catch { return null; } })() : undefined;
      const result = await registeredAppStorage(c.req.param('workspaceOwnerNpub'), c.req.param('appNpub'), signer, operation, c.req.param('objectId'), body);
      c.header('Cache-Control', 'private, no-store');
      if ('bytes' in result && result.bytes && result.metadata) {
        return new Response(method === 'head' ? null : new Uint8Array(result.bytes), { headers: {
          'Content-Type': result.metadata.content_type, 'Content-Length': String(result.metadata.size_bytes),
          'Content-Disposition': inlineContentDisposition(result.metadata.file_name).replace(/^inline/, /^image\/(png|jpeg|gif|webp|avif)$/.test(result.metadata.content_type) ? 'inline' : 'attachment'), 'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Referrer-Policy': 'no-referrer',
        } });
      }
      return c.json(result, operation === 'prepare' ? 201 : 200);
    } catch (error) {
      if (error instanceof AppStorageError) return c.json({ error: error.message, code: error.code }, error.status);
      throw error;
    }
  });
}
