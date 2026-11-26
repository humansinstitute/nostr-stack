import type { FlightDeckPgThreadUpdate } from '../types';
import { validateFlightDeckPgThreadTitle } from './flightdeck-pg-thread-titles';

export const THREAD_METADATA_MAX_BYTES = 65536;
export const THREAD_METADATA_MAX_DEPTH = 32;
export const THREAD_METADATA_MAX_NODES = 8192;
type FieldError = { path: string; code: string; message: string };

/** Application data only; no keys are interpreted as canonical thread fields. */
export function validateFlightDeckPgThreadUpdate(body: unknown): {
  update: FlightDeckPgThreadUpdate; fields: FieldError[];
} {
  const update: FlightDeckPgThreadUpdate = {};
  const fields: FieldError[] = [];
  const invalid = (path: string, message: string) => fields.push({ path, code: 'invalid', message });
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    invalid('body', 'body must be a JSON object');
    return { update, fields };
  }
  const input = body as Record<string, unknown>;
  if (input.title !== undefined) {
    const title = validateFlightDeckPgThreadTitle(input.title);
    if (title.error) invalid('title', title.error);
    else update.title = title.title;
  }
  if (input.metadata !== undefined) {
    if (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata)) {
      invalid('metadata', 'metadata must be a JSON object');
    } else {
      // Iterative traversal bounds work before serialization, including service callers.
      const pending = [{ value: input.metadata as unknown, depth: 0 }];
      let nodes = 0;
      try {
        while (pending.length) {
          const { value, depth } = pending.pop()!;
          if (++nodes > THREAD_METADATA_MAX_NODES || depth > THREAD_METADATA_MAX_DEPTH) throw new Error('metadata exceeds depth or node limit');
          if (value === null || typeof value === 'boolean') continue;
          if (typeof value === 'string' && !value.includes('\u0000') && value.isWellFormed()) continue;
          if (typeof value === 'number' && Number.isFinite(value)) continue;
          if (typeof value !== 'object' || value === null) throw new Error('metadata must contain JSON values');
          if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('metadata must contain JSON objects');
          for (const [key, child] of Object.entries(value)) {
            if (key.includes('\u0000') || !key.isWellFormed()) throw new Error('metadata keys must be valid Unicode without NUL');
            pending.push({ value: child, depth: depth + 1 });
            if (pending.length > THREAD_METADATA_MAX_NODES) throw new Error('metadata exceeds node limit');
          }
        }
        if (Buffer.byteLength(JSON.stringify(input.metadata), 'utf8') > THREAD_METADATA_MAX_BYTES) throw new Error('metadata exceeds 65536 UTF-8 bytes');
        update.metadata = input.metadata as Record<string, unknown>;
      } catch (error) {
        invalid('metadata', error instanceof Error ? error.message : 'invalid metadata');
      }
    }
    if (typeof input.row_version !== 'number' || !Number.isInteger(input.row_version) || input.row_version < 1 || input.row_version > 2147483647) {
      invalid('row_version', 'metadata requires a positive integer row_version (maximum 2147483647)');
    } else update.row_version = input.row_version;
  } else if (input.row_version !== undefined && input.row_version !== null) {
    // Preserve legacy title-only numeric-string handling.
    const version = Number(input.row_version);
    if (!Number.isInteger(version) || version < 1 || version > 2147483647) invalid('row_version', 'row_version must be a positive integer');
    else update.row_version = version;
  }
  if (input.title === undefined && input.metadata === undefined) invalid('body', 'title or metadata is required');
  return { update, fields };
}
