import { expect, test } from 'bun:test';
import { revocableStream } from '../src/services/revocable-stream';

test('a download stops and cancels its upstream when authority is revoked mid-transfer', async () => {
  let authorized = true;
  let cancelled = false;
  let next = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array([++next])); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const reader = revocableStream(source, async () => authorized).getReader();
  expect((await reader.read()).value).toEqual(new Uint8Array([1]));
  authorized = false;
  await expect(reader.read()).rejects.toThrow('storage_access_revoked');
  expect(cancelled).toBe(true);
});

test('download cancellation propagates and an unavailable authority fails closed', async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array([1])); },
    cancel() { cancelled = true; },
  });
  const reader = revocableStream(source, async () => { throw new Error('authority unavailable'); }).getReader();
  await expect(reader.read()).rejects.toThrow('authority unavailable');
  expect(cancelled).toBe(true);
});
