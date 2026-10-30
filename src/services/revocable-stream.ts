/** Recheck authority after each upstream read, before handing bytes to a client. */
export function revocableStream(
  source: ReadableStream<Uint8Array>,
  canRead: () => Promise<boolean>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { controller.close(); return; }
        if (!await canRead()) {
          await reader.cancel('access revoked');
          controller.error(new Error('storage_access_revoked'));
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 });
}
