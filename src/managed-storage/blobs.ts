import { config } from '../config';
import { boundedBytes, requireCondition } from './contract';

export interface StorageBlobs {
  write(key: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  read(key: string, limit: number, signal: AbortSignal): Promise<Uint8Array>;
}
export function createStorageBlobs(): StorageBlobs {
  const bucket = new Bun.S3Client({
    accessKeyId: config.storage.s3AccessKey,
    secretAccessKey: config.storage.s3SecretKey,
    bucket: config.storage.s3Bucket,
    region: config.storage.s3Region,
    endpoint: config.storage.s3Endpoint,
    virtualHostedStyle: !config.storage.s3ForcePathStyle,
  });
  // These internal bucket URLs never leave Tower. fetch supplies cancellable IO;
  // callers receive only Tower's revision-checked, size-bounded stream endpoint.
  return {
    async write(key, bytes, signal) {
      const url = bucket.presign(key, { method: 'PUT', expiresIn: 60, type: 'application/octet-stream' });
      const response = await fetch(url, { method: 'PUT', body: new Uint8Array(bytes), redirect: 'error', signal,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength) } });
      await response.body?.cancel();
      requireCondition(response.ok, 'storage_blob_unavailable', 502);
    },
    async read(key, limit, signal) {
      const url = bucket.presign(key, { method: 'GET', expiresIn: 60 });
      const response = await fetch(url, { redirect: 'error', signal });
      requireCondition(response.ok, 'storage_blob_unavailable', 502);
      if (Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel();
        requireCondition(false, 'storage_identity_mismatch', 409);
      }
      return boundedBytes(response.body, limit, signal);
    },
  };
}
