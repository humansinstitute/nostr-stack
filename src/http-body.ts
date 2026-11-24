import { HostingError } from './services/hosting-billing';

/** Reads a request body with a hard byte ceiling WHILE streaming, so an oversized or endless (chunked) body is cut off at `max` instead of
 * being buffered whole before a length check. A declared Content-Length above the ceiling is refused without reading anything. */
export async function readBoundedText(request: Request, max: number): Promise<string> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d{1,15}$/.test(declared) || Number(declared) > max)) throw new HostingError(413, 'body_too_large');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { await reader.cancel().catch(() => {}); throw new HostingError(413, 'body_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock?.(); }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw new HostingError(400, 'invalid_json'); }
}
