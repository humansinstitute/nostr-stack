import net from 'node:net';
import http2 from 'node:http2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { initializeStorageBucket } from '../src/scripts/storage-init';

interface ProbeResult {
  name: string;
  pass: boolean;
  detail: unknown;
}

async function tcpProbe(host: string, port: number): Promise<'open' | 'closed'> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 1500 });
    s.on('connect', () => {
      s.destroy();
      resolve('open');
    });
    s.on('error', () => {
      s.destroy();
      resolve('closed');
    });
    s.on('timeout', () => {
      s.destroy();
      resolve('closed');
    });
  });
}

async function grpcProbe(
  host: string,
  port: number,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status?: number; grpcStatus?: string; grpcMessage?: string; error?: string }> {
  return new Promise((resolve) => {
    const client = http2.connect(`http://${host}:${port}`);
    let done = false;
    const finish = (v: any) => {
      if (!done) {
        done = true;
        try {
          client.close();
        } catch {}
        resolve(v);
      }
    };
    const timer = setTimeout(() => finish({ error: 'timeout' }), 3000);
    client.on('error', (e: any) => {
      clearTimeout(timer);
      finish({ error: e.code || e.message });
    });
    const req = client.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/grpc',
      te: 'trailers',
      ...extraHeaders,
    });
    let headers: any = {};
    let trailers: any = {};
    req.on('response', (h) => {
      headers = h;
    });
    req.on('trailers', (t) => {
      trailers = t;
    });
    req.on('error', (e: any) => {
      clearTimeout(timer);
      finish({ error: e.code || e.message });
    });
    req.on('end', () => {
      clearTimeout(timer);
      finish({
        status: headers[':status'],
        grpcStatus: headers['grpc-status'] ?? trailers['grpc-status'],
        grpcMessage: headers['grpc-message'] ?? trailers['grpc-message'],
      });
    });
    req.write(Buffer.from([0, 0, 0, 0, 0]));
    req.end();
  });
}

async function streamSha256(body: any): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of body) {
    const buf = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
    bytes += buf.byteLength;
    hash.update(buf);
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function putMultipart(
  s3: S3Client,
  bucket: string,
  key: string,
  totalBytes: number,
  partBytes = 16 * 1024 * 1024,
): Promise<{ sha256: string; etag: string }> {
  const create = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: 'application/octet-stream',
    }),
  );
  const uploadId = create.UploadId!;
  const totalHash = createHash('sha256');
  const parts: { ETag: string; PartNumber: number }[] = [];
  let remaining = totalBytes;
  let partNumber = 1;
  // Deterministic PRNG pattern block to generate large bodies quickly without excessive CPU
  const seedBlock = randomBytes(1024 * 1024);

  while (remaining > 0) {
    const sz = Math.min(remaining, partBytes);
    const partBuf = Buffer.allocUnsafe(sz);
    for (let off = 0; off < sz; off += seedBlock.length) {
      const len = Math.min(seedBlock.length, sz - off);
      seedBlock.copy(partBuf, off, 0, len);
      partBuf[off] = (partBuf[off]! ^ partNumber ^ (off >> 20)) & 0xff;
    }
    totalHash.update(partBuf);
    const up = await s3.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: partBuf,
      }),
    );
    parts.push({ ETag: up.ETag!, PartNumber: partNumber });
    remaining -= sz;
    partNumber++;
  }

  const completed = await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }),
  );
  return { sha256: totalHash.digest('hex'), etag: completed.ETag! };
}

async function main() {
  const host = process.env.SEAWEEDFS_HOST || 'seaweedfs';
  const port = Number(process.env.SEAWEEDFS_PORT || '8333');
  const bucket = process.env.STORAGE_S3_BUCKET || 'nstack-e1-test';
  const appKey = process.env.STORAGE_S3_ACCESS_KEY!;
  const appSecret = process.env.STORAGE_S3_SECRET_KEY!;
  const admKey = process.env.SEAWEEDFS_ADMIN_ACCESS_KEY!;
  const admSecret = process.env.SEAWEEDFS_ADMIN_SECRET_KEY!;
  const runLoad = process.argv.includes('--load');
  const loadTargetMiB = Number(process.env.E1_LOAD_MIB || '2100');

  if (!appKey || !appSecret || !admKey || !admSecret) {
    throw new Error('Missing SeaweedFS test credentials in environment');
  }

  const endpoint = `http://${host}:${port}`;
  const results: ProbeResult[] = [];
  const add = (name: string, pass: boolean, detail: unknown) => results.push({ name, pass, detail });

  // 1. Port isolation checks (master, volume, filer, Iceberg, Lance must be closed from sibling)
  for (const [label, p] of [
    ['master_http_9333_closed', 9333],
    ['master_grpc_19333_closed', 19333],
    ['volume_http_8080_closed', 8080],
    ['volume_grpc_18080_closed', 18080],
    ['filer_http_8888_closed', 8888],
    ['filer_grpc_18888_closed', 18888],
    ['iceberg_8181_closed', 8181],
    ['lance_9101_closed', 9101],
  ] as const) {
    const state = await tcpProbe(host, p);
    add(label, state === 'closed', { port: p, state });
  }

  // 2. S3 gRPC 18333 negative probes (unauthenticated & forged Bearer token must fail closed)
  const fakeJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjk5OTk5OTk5OTl9.invalid-signature';
  for (const method of [
    '/messaging_pb.SeaweedS3IamCache/PutIdentity',
    '/messaging_pb.SeaweedS3IamCache/RemoveIdentity',
    '/s3_lifecycle_pb.SeaweedS3LifecycleInternal/LifecycleDelete',
  ]) {
    const unauth = await grpcProbe(host, 18333, method);
    add(`grpc_18333_unauth_${method.split('/').at(-1)}`, unauth.grpcStatus === '16' || unauth.grpcStatus === '7' || Boolean(unauth.error), unauth);
    const forged = await grpcProbe(host, 18333, method, { authorization: `Bearer ${fakeJwt}` });
    add(`grpc_18333_forged_jwt_${method.split('/').at(-1)}`, forged.grpcStatus === '16' || forged.grpcStatus === '7' || Boolean(forged.error), forged);
  }

  // 3. Initialize bucket + sentinel + RW probe via real storage-init
  const initSummary = await initializeStorageBucket({
    provider: 'seaweedfs',
    endpoint,
    region: 'us-east-1',
    bucket,
    adminAccessKey: admKey,
    adminSecretKey: admSecret,
    rwAccessKey: appKey,
    rwSecretKey: appSecret,
    forcePathStyle: true,
    writeSentinel: true,
    verifyAnonymousDenied: true,
    probeRw: true,
    maxAttempts: 5,
    retryDelayMs: 500,
  });
  add('storage_init_and_sentinel', initSummary.ok && Boolean(initSummary.sentinel_id) && initSummary.rw_probe_passed, initSummary);

  // 4. Anonymous, wrong-key, S3Tables, embedded IAM, and cross-bucket negative probes
  for (const [label, method, path, headers, body] of [
    ['anon_root_denied', 'GET', '/', {}, undefined],
    ['anon_bucket_list_denied', 'GET', `/${bucket}`, {}, undefined],
    ['anon_put_denied', 'PUT', `/${bucket}/anon-denied.txt`, {}, 'nope'],
    ['s3tables_create_bucket_anon_denied', 'PUT', '/buckets', { 'x-amz-target': 'S3Tables.CreateTableBucket' }, '{"name":"evil"}'],
    ['s3tables_list_buckets_anon_denied', 'GET', '/buckets', {}, undefined],
    ['s3tables_create_table_anon_denied', 'PUT', '/tables/arn:aws:s3tables:us-east-1:000000000000:bucket/evil/ns', {}, '{"name":"t"}'],
    ['iam_create_user_anon_denied', 'POST', '/', { 'content-type': 'application/x-www-form-urlencoded' }, 'Action=CreateUser&UserName=evil&Version=2010-05-08'],
  ] as const) {
    const r = await fetch(endpoint + path, { method, headers: headers as any, body });
    await r.body?.cancel();
    add(label, r.status === 401 || r.status === 403 || r.status === 404 || r.status === 405, { status: r.status });
  }

  // Signed S3Tables & IAM probes using Tower RW identity (must fail closed!)
  const bunApp = new Bun.S3Client({
    accessKeyId: appKey,
    secretAccessKey: appSecret,
    bucket,
    region: 'us-east-1',
    endpoint,
    virtualHostedStyle: false,
  });
  const signedBucketsUrl = bunApp.presign('../buckets', { method: 'PUT', expiresIn: 60 });
  const s3TablesSigned = await fetch(signedBucketsUrl, {
    method: 'PUT',
    headers: { 'x-amz-target': 'S3Tables.CreateTableBucket', 'content-type': 'application/json' },
    body: '{"name":"evil-signed"}',
  });
  await s3TablesSigned.body?.cancel();
  add('s3tables_signed_app_denied', s3TablesSigned.status >= 400, { status: s3TablesSigned.status });

  // CORS parity check
  const corsRes = await fetch(`${endpoint}/${bucket}/cors-test`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://app.example.com', 'Access-Control-Request-Method': 'PUT' },
  });
  await corsRes.body?.cancel();
  add(
    'cors_preflight_parity',
    corsRes.status >= 200 && corsRes.status < 300 && Boolean(corsRes.headers.get('access-control-allow-origin')) && (corsRes.headers.get('access-control-allow-methods') || '').includes('PUT'),
    {
      status: corsRes.status,
      acao: corsRes.headers.get('access-control-allow-origin'),
      acam: corsRes.headers.get('access-control-allow-methods'),
    },
  );

  // Wrong-key & least-privilege checks
  const badS3 = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: 'wrong-key', secretAccessKey: 'wrong-secret-0123456789' } });
  const appS3 = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: appKey, secretAccessKey: appSecret } });

  try {
    await badS3.send(new ListObjectsV2Command({ Bucket: bucket }));
    add('wrong_key_denied', false, { status: 200 });
  } catch (e: any) {
    const st = e?.$metadata?.httpStatusCode;
    add('wrong_key_denied', st === 403 || st === 401, { status: st, code: e?.name });
  }
  try {
    await appS3.send(new CreateBucketCommand({ Bucket: 'unauthorized-bucket-e1' }));
    add('app_create_other_bucket_denied', false, { status: 200 });
  } catch (e: any) {
    const st = e?.$metadata?.httpStatusCode;
    add('app_create_other_bucket_denied', st === 403, { status: st, code: e?.name });
  }
  try {
    await appS3.send(new DeleteBucketCommand({ Bucket: bucket }));
    add('app_delete_bucket_denied', false, { status: 200 });
  } catch (e: any) {
    const st = e?.$metadata?.httpStatusCode;
    add('app_delete_bucket_denied', st === 403, { status: st, code: e?.name });
  }

  // 5. Functional parity: unversioned, If-Match + Range, zero-byte, metadata, presigned PUT, delete
  const ver = await appS3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
  add('bucket_unversioned', ver.$metadata.httpStatusCode === 200 && !ver.Status && !ver.MFADelete, { Status: ver.Status ?? null, MFADelete: ver.MFADelete ?? null });

  const presignKey = `v4/e1-presign-${randomUUID()}.bin`;
  const presignPutUrl = bunApp.presign(presignKey, { method: 'PUT', type: 'application/octet-stream', expiresIn: 60 });
  const presignBytes = Buffer.from('presigned-upload-test-payload-0123456789');
  const presignPutRes = await fetch(presignPutUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: presignBytes });
  await presignPutRes.body?.cancel();
  const presignHead = await appS3.send(new HeadObjectCommand({ Bucket: bucket, Key: presignKey }));
  const presignGetUrl = bunApp.presign(presignKey, { method: 'GET', expiresIn: 60 });
  const rangeOk = await fetch(presignGetUrl, { headers: { 'If-Match': presignHead.ETag!, Range: 'bytes=0-8' } });
  const rangeBody = await rangeOk.text();
  const ifMatchMiss = await fetch(presignGetUrl, { headers: { 'If-Match': '"00000000000000000000000000000000"' } });
  await ifMatchMiss.body?.cancel();
  const delPresign = await appS3.send(new DeleteObjectCommand({ Bucket: bucket, Key: presignKey }));
  add(
    'presign_ifmatch_range_delete_parity',
    presignPutRes.ok && rangeOk.status === 206 && rangeBody === 'presigned' && ifMatchMiss.status === 412 && delPresign.$metadata.httpStatusCode === 204,
    { putStatus: presignPutRes.status, rangeStatus: rangeOk.status, rangeBody, ifMatchMissStatus: ifMatchMiss.status, deleteStatus: delPresign.$metadata.httpStatusCode },
  );

  // Zero-byte + custom metadata check
  const zeroKey = `v4/e1-zero-${randomUUID()}.txt`;
  await appS3.send(new PutObjectCommand({ Bucket: bucket, Key: zeroKey, Body: Buffer.alloc(0), ContentType: 'text/plain', Metadata: { 'x-test': 'zero' } }));
  const zeroHead = await appS3.send(new HeadObjectCommand({ Bucket: bucket, Key: zeroKey }));
  const zeroGet = await appS3.send(new GetObjectCommand({ Bucket: bucket, Key: zeroKey }));
  const zeroRead = await streamSha256(zeroGet.Body);
  await appS3.send(new DeleteObjectCommand({ Bucket: bucket, Key: zeroKey }));
  add(
    'zero_byte_and_metadata_parity',
    zeroHead.ContentLength === 0 && zeroRead.bytes === 0 && zeroRead.sha256 === createHash('sha256').update('').digest('hex') && zeroHead.Metadata?.['x-test'] === 'zero',
    { contentLength: zeroHead.ContentLength, bytes: zeroRead.bytes, metadata: zeroHead.Metadata },
  );

  // 6. Optional E1 mixed >=2 GiB load + >=260 MiB large-object qualification
  let loadSummary: any = null;
  if (runLoad) {
    const startedAt = Date.now();
    const targetBytes = loadTargetMiB * 1024 * 1024;
    let totalBytesWritten = 0;
    let objectsVerified = 0;
    let mismatches = 0;
    let server5xx = 0;
    const createdKeys: string[] = [];

    const checkOp = async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e: any) {
        if ((e?.$metadata?.httpStatusCode ?? 0) >= 500) server5xx++;
        throw e;
      }
    };

    // 1x 260 MiB large multipart object (exceeds local max 238.6 MiB)
    const largeBytes = 260 * 1024 * 1024;
    const largeKey = `e1-load/large-260mib-${randomUUID()}.bin`;
    createdKeys.push(largeKey);
    await checkOp(async () => {
      const { sha256, etag } = await putMultipart(appS3, bucket, largeKey, largeBytes, 16 * 1024 * 1024);
      const got = await appS3.send(new GetObjectCommand({ Bucket: bucket, Key: largeKey }));
      const rb = await streamSha256(got.Body);
      if (rb.bytes !== largeBytes || rb.sha256 !== sha256) mismatches++;
      // Verify Range + If-Match on large multipart object
      const largeUrl = bunApp.presign(largeKey, { method: 'GET', expiresIn: 120 });
      const rng = await fetch(largeUrl, { headers: { 'If-Match': etag, Range: 'bytes=1048576-1049599' } });
      const rngBuf = new Uint8Array(await rng.arrayBuffer());
      if (rng.status !== 206 || rngBuf.byteLength !== 1024) mismatches++;
      totalBytesWritten += largeBytes;
      objectsVerified++;
    });

    // Mix of small (0 B, 64 KiB, 1 MiB) objects concurrently
    const smallSizes = [
      ...Array(20).fill(0),
      ...Array(60).fill(64 * 1024),
      ...Array(24).fill(1024 * 1024),
    ];
    for (let i = 0; i < smallSizes.length; i += 4) {
      await Promise.all(
        smallSizes.slice(i, i + 4).map(async (sz, idx) => {
          const key = `e1-load/small-${i + idx}-${randomUUID()}.bin`;
          createdKeys.push(key);
          const buf = sz > 0 ? randomBytes(sz) : Buffer.alloc(0);
          const expectedSha = createHash('sha256').update(buf).digest('hex');
          await checkOp(async () => {
            await appS3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buf, ContentType: 'application/octet-stream' }));
            const got = await appS3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
            const rb = await streamSha256(got.Body);
            if (rb.bytes !== sz || rb.sha256 !== expectedSha) mismatches++;
            totalBytesWritten += sz;
            objectsVerified++;
          });
        }),
      );
    }

    // Remaining bytes up to targetBytes using 128 MiB multipart objects
    let partIdx = 0;
    while (totalBytesWritten < targetBytes) {
      const chunkSz = Math.min(128 * 1024 * 1024, targetBytes - totalBytesWritten);
      const key = `e1-load/bulk-${partIdx++}-${randomUUID()}.bin`;
      createdKeys.push(key);
      await checkOp(async () => {
        const { sha256 } = await putMultipart(appS3, bucket, key, chunkSz, 16 * 1024 * 1024);
        const got = await appS3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const rb = await streamSha256(got.Body);
        if (rb.bytes !== chunkSz || rb.sha256 !== sha256) mismatches++;
        totalBytesWritten += chunkSz;
        objectsVerified++;
      });
    }

    // Clean up load objects
    for (let i = 0; i < createdKeys.length; i += 8) {
      await Promise.all(
        createdKeys.slice(i, i + 8).map((Key) => appS3.send(new DeleteObjectCommand({ Bucket: bucket, Key }))),
      );
    }

    const elapsedSec = Number(((Date.now() - startedAt) / 1000).toFixed(2));
    loadSummary = {
      totalBytesWritten,
      totalGiB: Number((totalBytesWritten / (1024 ** 3)).toFixed(3)),
      objectsVerified,
      mismatches,
      server5xx,
      elapsedSec,
    };
    add('e1_load_2gib_zero_5xx_zero_mismatch', totalBytesWritten >= 2 * 1024 ** 3 && mismatches === 0 && server5xx === 0, loadSummary);
  }

  const allPass = results.every((r) => r.pass);
  console.log(JSON.stringify({ allPass, results, loadSummary }, null, 2));
  if (!allPass) process.exit(1);
}

await main();
