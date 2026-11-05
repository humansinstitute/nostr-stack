import { createHash } from 'node:crypto';

export const PROTOCOL = 'managed-app-storage-v1';
export const PREFIX = '/api/v4/managed-app-storage';
export const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
export const CONTROL_BYTES = 16 * 1024;
export const TOKEN_TTL_MS = 60_000;
export const TRANSFER_MS = 15_000;
export const TOKEN_HEADER = 'X-Managed-Storage-Token';
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const sha256 = /^[0-9a-f]{64}$/;
export const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export class StorageDelegationError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export function requireCondition(value: unknown, code: string, status = 400): asserts value {
  if (!value) throw new StorageDelegationError(code, status);
}
export function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  requireCondition(value && typeof value === 'object' && !Array.isArray(value), 'storage_request_invalid');
  const row = value as Record<string, unknown>;
  requireCondition(Object.keys(row).every(key => keys.includes(key)), 'storage_request_invalid');
  return row;
}
export function httpsOrigin(value: unknown): string {
  requireCondition(typeof value === 'string', 'storage_config_invalid', 503);
  let url: URL;
  try { url = new URL(value); } catch { throw new StorageDelegationError('storage_config_invalid', 503); }
  requireCondition(value.length <= 1024 && url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/'
    && !url.search && !url.hash && value === url.origin, 'storage_config_invalid', 503);
  return url.origin;
}

// The same deadline applies to headers and every reader.read(), including stalled streams.
export async function boundedBytes(stream: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  requireCondition(stream, 'storage_body_required');
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => { reject(new StorageDelegationError('storage_timeout', 408)); void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      requireCondition(!signal.aborted, 'storage_timeout', 408);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw new StorageDelegationError('storage_body_too_large', 413);
      }
      chunks.push(part.value);
    }
    return new Uint8Array(Buffer.concat(chunks, size));
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
