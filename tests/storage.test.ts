import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import postgres from 'postgres';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_storage';

let sql: ReturnType<typeof postgres>;
let app: any;

const ownerSecret = new Uint8Array(32).fill(21);
const memberSecret = new Uint8Array(32).fill(22);
const outsiderSecret = new Uint8Array(32).fill(23);
const OWNER = nip19.npubEncode(getPublicKey(ownerSecret));
const MEMBER = nip19.npubEncode(getPublicKey(memberSecret));
const OUTSIDER = nip19.npubEncode(getPublicKey(outsiderSecret));

const WORKSPACE_NPUB = 'npub1workspace_storage_test_00001';
const GROUP_ID = '00000000-0000-0000-0000-000000000501';
const GROUP_NPUB = 'npub1group_storage_test_epoch1';
const RUN_S3_STORAGE_TESTS = /^(1|true|yes)$/i.test(process.env.RUN_TOWER_STORAGE_S3_TESTS || '');
const s3StorageTest = RUN_S3_STORAGE_TESTS ? test : test.skip;
let s3Available = false;
let s3AvailabilityChecked = false;

async function checkS3Availability(): Promise<boolean> {
  if (s3AvailabilityChecked) return s3Available;
  s3AvailabilityChecked = true;
  if (!RUN_S3_STORAGE_TESTS) {
    s3Available = false;
    return s3Available;
  }

  const endpoint = process.env.STORAGE_S3_ENDPOINT || 'http://127.0.0.1:9000';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      await fetch(endpoint, { method: 'GET', signal: controller.signal });
      s3Available = true;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    s3Available = false;
    // Keep this as a warning so full suite can stay green in environments without MinIO/S3.
    console.warn(`[storage.test] RUN_TOWER_STORAGE_S3_TESTS is enabled but STORAGE_S3_ENDPOINT is unreachable: ${endpoint}. Skipping S3-dependent storage tests.`);
  }
  return s3Available;
}

function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function authHeader(path: string, method: string, secret: Uint8Array, body?: string) {
  const url = `http://localhost${path}`;
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];

  if (body !== undefined && method.toUpperCase() !== 'GET') {
    tags.push(['payload', sha256Hex(body)]);
  }

  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }, secret);

  return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}

beforeAll(async () => {
  process.env.STORAGE_S3_ENDPOINT = process.env.STORAGE_S3_ENDPOINT || 'http://127.0.0.1:9000';
  process.env.STORAGE_S3_REGION = process.env.STORAGE_S3_REGION || 'us-east-1';
  process.env.STORAGE_S3_ACCESS_KEY = process.env.STORAGE_S3_ACCESS_KEY || 'superbased';
  process.env.STORAGE_S3_SECRET_KEY = process.env.STORAGE_S3_SECRET_KEY || 'superbased-secret';
  process.env.STORAGE_S3_BUCKET = process.env.STORAGE_S3_BUCKET || 'superbased-storage';
  process.env.STORAGE_S3_FORCE_PATH_STYLE = process.env.STORAGE_S3_FORCE_PATH_STYLE || 'true';

  const adminOpts: Parameters<typeof postgres>[0] = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: 'postgres',
  };
  if (process.env.DB_USER) adminOpts.username = process.env.DB_USER;
  if (process.env.DB_PASSWORD) adminOpts.password = process.env.DB_PASSWORD;

  const admin = postgres(adminOpts);
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }

  const testOpts: Parameters<typeof postgres>[0] = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: TEST_DB,
  };
  if (process.env.DB_USER) testOpts.username = process.env.DB_USER;
  if (process.env.DB_PASSWORD) testOpts.password = process.env.DB_PASSWORD;

  sql = postgres(testOpts);
  setDb(sql);

  const { readFileSync } = await import('fs');
  const { join, dirname } = await import('path');
  const { fileURLToPath } = await import('url');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(join(__dirname, '../src/schema/001_init.sql'), 'utf-8');
  const statements = splitSqlStatements(migration);
  for (const stmt of statements) {
    await sql.unsafe(stmt);
  }

  const { hostingStoragePeakV1Sql } = await import('../src/schema/hosting-storage-peak-v1');
  await sql.unsafe(hostingStoragePeakV1Sql);
  await sql.unsafe(readFileSync(join(__dirname, '../src/schema/app-db-native-v1.sql'), 'utf8'));

  // Set up workspace, group, and membership for tests
  await sql`
    INSERT INTO v4_groups (id, owner_npub, name, group_npub, group_kind)
    VALUES (${GROUP_ID}, ${WORKSPACE_NPUB}, 'Test Group', ${GROUP_NPUB}, 'shared')
  `;
  await sql`
    INSERT INTO v4_group_epochs (group_id, epoch, group_npub, created_by_npub)
    VALUES (${GROUP_ID}, 1, ${GROUP_NPUB}, ${OWNER})
  `;
  await sql`
    INSERT INTO v4_workspaces (workspace_owner_npub, creator_npub, name, wrapped_workspace_nsec, wrapped_by_npub, default_group_id)
    VALUES (${WORKSPACE_NPUB}, ${OWNER}, 'Test Workspace', 'wrapped_nsec_test', ${OWNER}, ${GROUP_ID})
  `;
  await sql`
    INSERT INTO v4_group_members (group_id, member_npub)
    VALUES
      (${GROUP_ID}, ${OWNER}),
      (${GROUP_ID}, ${MEMBER})
  `;

  const serverModule = await import('../src/server');
  // Legacy fixture without the runtime schema and without agent classifications: explicit, test-only ceiling provider.
  const { unclassifiedFixtureCeiling } = await import('../src/services/agent-notifications');
  app = serverModule.createApp({ agentCeiling: unclassifiedFixtureCeiling });
});

afterAll(async () => {
  if (sql) await sql.end();
});

describe('Storage API', () => {
  test('same-object refresh requires uploader and current ACL; completed objects have no upload handle', async () => {
    const [object] = await sql`
      INSERT INTO v4_storage_objects (owner_npub, created_by_npub, storage_path, content_type, access_group_ids, owner_group_id)
      VALUES (${WORKSPACE_NPUB}, ${MEMBER}, 'refresh-same-object', 'text/plain', ${[GROUP_ID]}, ${GROUP_ID}) RETURNING *
    `;
    const path = `/api/v4/storage/${object.id}/upload-url`;
    const refresh = (secret: Uint8Array) => app.request(path, { method: 'POST',
      headers: { Authorization: authHeader(path, 'POST', secret, '{}'), 'content-type': 'application/json' }, body: '{}' });
    expect((await app.request(path, { method: 'POST' })).status).toBe(401);
    expect((await refresh(outsiderSecret)).status).toBe(404);
    expect((await refresh(ownerSecret)).status).toBe(404); // readable is not upload authority
    const first = await refresh(memberSecret);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const descriptor = await first.json();
    expect(descriptor.object_id).toBe(object.id);
    expect(descriptor.upload_url).toBeTruthy();
    const [unchanged] = await sql`SELECT * FROM v4_storage_objects WHERE id=${object.id}`;
    expect(unchanged).toEqual(object);
    await sql`DELETE FROM v4_group_members WHERE group_id=${GROUP_ID} AND member_npub=${MEMBER}`;
    expect((await refresh(memberSecret)).status).toBe(404);
    await sql`INSERT INTO v4_group_members(group_id,member_npub) VALUES (${GROUP_ID},${MEMBER})`;
    await sql`UPDATE v4_storage_objects SET completed_at=NOW(), size_bytes=3, sha256_hex=${'a'.repeat(64)} WHERE id=${object.id}`;
    const completed = await refresh(memberSecret);
    expect(completed.status).toBe(200);
    expect(completed.headers.get('cache-control')).toBe('no-store');
    const reused = await completed.json();
    expect(reused.object_id).toBe(object.id);
    expect(reused.completed_at).toBeTruthy();
    expect(reused.upload_url).toBeNull();
    expect(reused.size_bytes).toBe('3');
    await sql`UPDATE v4_storage_objects SET registered_app_npub=${MEMBER}, owner_group_id=NULL, access_group_ids='{}' WHERE id=${object.id}`;
    expect((await refresh(memberSecret)).status).toBe(404);
  });

  test('refresh presigns the existing key with bounded expiry and never allocates', async () => {
    const { config } = await import('../src/config');
    const previous = config.storage.s3PublicEndpoint;
    config.storage.s3PublicEndpoint = 'https://storage.fixture.invalid';
    try {
      const [object] = await sql`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,storage_path,content_type)
        VALUES(${WORKSPACE_NPUB},${MEMBER},'private/existing-key','text/plain') RETURNING id`;
      const [before] = await sql`SELECT count(*) AS count FROM v4_storage_objects`;
      const path = `/api/v4/storage/${object.id}/upload-url`;
      const result = await app.request(path, { method:'POST', headers:{ Authorization:authHeader(path,'POST',memberSecret,'{}'), 'content-type':'application/json' }, body:'{}' });
      expect(result.status).toBe(200);
      const descriptor = await result.json();
      expect(descriptor.object_id).toBe(object.id);
      const url = new URL(descriptor.upload_url);
      expect(url.origin).toBe('https://storage.fixture.invalid');
      expect(url.pathname.endsWith('/private/existing-key')).toBe(true);
      expect(url.searchParams.has('X-Amz-Signature')).toBe(true);
      expect(Number(url.searchParams.get('X-Amz-Expires'))).toBe(Math.max(60,config.storage.presignUploadTtlSeconds));
      const [after] = await sql`SELECT count(*) AS count FROM v4_storage_objects`;
      expect(after.count).toBe(before.count);
    } finally { config.storage.s3PublicEndpoint = previous; }
  });

  test('workspace-bound refresh loses authority when uploader membership is revoked', async () => {
    const [actor] = await sql`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${MEMBER},'human') RETURNING id`;
    const [workspace] = await sql`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id)
      VALUES('refresh-tower','refresh-service',${MEMBER},'refresh-app','Refresh fixture',${actor.id}) RETURNING id`;
    await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspace.id},${actor.id},'owner') ON CONFLICT DO NOTHING`;
    const [object] = await sql`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,storage_path,content_type,pg_workspace_id)
      VALUES(${MEMBER},${MEMBER},'refresh-workspace-bound','text/plain',${workspace.id}) RETURNING id`;
    const path = `/api/v4/storage/${object.id}/upload-url`;
    const refresh = () => app.request(path, { method:'POST', headers:{ Authorization:authHeader(path,'POST',memberSecret,'{}'), 'content-type':'application/json' }, body:'{}' });
    expect((await refresh()).status).toBe(200);
    await sql`DELETE FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${workspace.id} AND actor_id=${actor.id}`;
    expect((await refresh()).status).toBe(404);
  });

  test('native content fence denies refresh of generic objects without registered_app_npub', async () => {
    const [actor] = await sql`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${OWNER},'human') RETURNING id`;
    const [workspace] = await sql`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id)
      VALUES('fence-tower','fence-service',${OWNER},'fence-app','Fence fixture',${actor.id}) RETURNING id`;
    await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspace.id},${actor.id},'owner') ON CONFLICT DO NOTHING`;
    const [scope] = await sql`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind,created_by_actor_id) VALUES(${workspace.id},'Scope','project',${actor.id}) RETURNING id`;
    const [channel] = await sql`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name,kind,created_by_actor_id) VALUES(${workspace.id},${scope.id},'Channel','channel',${actor.id}) RETURNING id`;
    const [object] = await sql`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,storage_path,content_type,pg_workspace_id)
      VALUES(${OWNER},${OWNER},'fenced-generic-object','application/x-fixture-record',${workspace.id}) RETURNING *`;
    const path = `/api/v4/storage/${object.id}/upload-url`;
    const refresh = () => app.request(path, { method:'POST', headers:{ Authorization:authHeader(path,'POST',ownerSecret,'{}'), 'content-type':'application/json' }, body:'{}' });
    expect((await refresh()).status).toBe(200);
    await sql`INSERT INTO flightdeck_pg_files(workspace_id,scope_id,channel_id,storage_object_id,created_by_actor_id,updated_by_actor_id)
      VALUES(${workspace.id},${scope.id},${channel.id},${object.id},${actor.id},${actor.id})`;
    await sql`INSERT INTO app_db_content_fences(workspace_id,channel_id,content_type) VALUES(${workspace.id},${channel.id},${object.content_type})`;
    const { isStorageContentFenced } = await import('../src/services/storage');
    expect(await isStorageContentFenced(object.id)).toBe(true);
    const denied = await refresh();
    expect(denied.status).toBe(404);
    expect((await denied.json()).upload_url).toBeUndefined();
    const [unchanged] = await sql`SELECT * FROM v4_storage_objects WHERE id=${object.id}`;
    expect(unchanged).toEqual(object);
  });

  test('private download handles stay on the authenticated Tower route', async () => {
    const [object] = await sql`
      INSERT INTO v4_storage_objects (owner_npub, created_by_npub, storage_path, content_type, is_public, completed_at)
      VALUES (${WORKSPACE_NPUB}, ${MEMBER}, 'private-revocable-download', 'text/plain', false, NOW())
      RETURNING id
    `;
    const { getStorageDownloadUrl } = await import('../src/services/storage');
    expect(await getStorageDownloadUrl(object.id)).toBeNull();
    const path = `/api/v4/storage/${object.id}/download-url`;
    const unsigned = await app.request(path);
    expect(unsigned.status).toBe(401);
    const signed = await app.request(path, { headers: { Authorization: authHeader(path, 'GET', memberSecret) } });
    expect(signed.status).toBe(200);
    const payload = await signed.json();
    expect(payload.download_url).toBe(`http://localhost/api/v4/storage/${object.id}/content`);
    const content = await app.request(new URL(payload.download_url).pathname);
    expect(content.status).toBe(401);
  });

  test('public direct download URLs pin the response type to the stored row type', async () => {
    const { getStorageDownloadUrl } = await import('../src/services/storage');
    const cases: Array<[string, string, string]> = [
      ['public-generic.html', 'application/octet-stream', 'application/octet-stream'],
      ['public-untyped.svg', '', 'application/octet-stream'],
      ['public-typed.json', 'application/json', 'application/json'],
    ];
    for (const [path, type, served] of cases) {
      const [object] = await sql`
        INSERT INTO v4_storage_objects (owner_npub, created_by_npub, storage_path, content_type, is_public, completed_at)
        VALUES (${WORKSPACE_NPUB}, ${MEMBER}, ${path}, ${type}, true, NOW())
        RETURNING id
      `;
      const url = new URL((await getStorageDownloadUrl(object.id))!);
      expect(url.pathname.endsWith(`/${path}`)).toBe(true);
      expect(url.searchParams.get('response-content-type')).toBe(served);
      expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    }
  });

  async function requireS3ForTest() {
    if (!await checkS3Availability()) return false;
    return true;
  }
  s3StorageTest('workspace owner can prepare, upload, complete, and fetch workspace-owned object', async () => {
    if (!await requireS3ForTest()) return;
    const preparePayload = JSON.stringify({
      owner_npub: WORKSPACE_NPUB,
      content_type: 'audio/webm;codecs=opus',
      size_bytes: 4,
      file_name: 'note.webm',
    });

    const prepareRes = await app.request('/api/v4/storage/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/storage/prepare', 'POST', ownerSecret, preparePayload),
      },
      body: preparePayload,
    });

    expect(prepareRes.status).toBe(200);
    const prepared = await prepareRes.json();
    expect(prepared.object_id).toBeTruthy();
    expect(prepared.owner_group_id).toBeNull();
    expect(prepared.is_public).toBe(false);
    expect(prepared.content_url).toContain(`/api/v4/storage/${prepared.object_id}/content`);

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const uploadPath = `/api/v4/storage/${prepared.object_id}`;
    const uploadPayload = JSON.stringify({
      base64_data: Buffer.from(bytes).toString('base64'),
    });
    const uploadRes = await app.request(uploadPath, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(uploadPath, 'PUT', ownerSecret, uploadPayload),
      },
      body: uploadPayload,
    });
    expect(uploadRes.status).toBe(200);

    const completePath = `/api/v4/storage/${prepared.object_id}/complete`;
    const completePayload = JSON.stringify({
      sha256_hex: sha256Hex(bytes),
      size_bytes: bytes.byteLength,
    });
    const completeRes = await app.request(completePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(completePath, 'POST', ownerSecret, completePayload),
      },
      body: completePayload,
    });
    expect(completeRes.status).toBe(200);
    const completed = await completeRes.json();
    expect(completed.owner_group_id).toBeNull();

    expect(completed.blossom_url).toBe(`http://localhost/${sha256Hex(bytes)}`);
    expect(completed.blossom_auth).toBe('nostr');
    const blobPath = `/${sha256Hex(bytes)}`;
    const blob = await app.request(blobPath, { headers: { Authorization: authHeader(blobPath, 'GET', ownerSecret) } });
    expect(blob.status).toBe(200);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    const head = await app.request(blobPath, { method: 'HEAD', headers: { Authorization: authHeader(blobPath, 'HEAD', ownerSecret) } });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('4');
    expect(await head.text()).toBe('');
    const range = await app.request(blobPath, { headers: { Range: 'bytes=1-2', Authorization: authHeader(blobPath, 'GET', ownerSecret) } });
    expect(range.status).toBe(206);
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(new Uint8Array([2, 3]));

    const contentPath = `/api/v4/storage/${prepared.object_id}/content`;
    const contentRes = await app.request(contentPath, {
      headers: {
        Authorization: authHeader(contentPath, 'GET', ownerSecret),
      },
    });
    expect(contentRes.status).toBe(200);
    const fetched = new Uint8Array(await contentRes.arrayBuffer());
    expect(Array.from(fetched)).toEqual([1, 2, 3, 4]);
    expect(contentRes.headers.get('content-type')).toContain('audio/webm');

    // A still-valid presigned PUT can overwrite S3 after completion: stale hashes must stop working
    // and verifyStorageIdentity must fail closed without re-adopting tampered bytes (E3).
    const { config } = await import('../src/config');
    const bucket = new Bun.S3Client({ accessKeyId: config.storage.s3AccessKey, secretAccessKey: config.storage.s3SecretKey,
      endpoint: config.storage.s3Endpoint, bucket: config.storage.s3Bucket, region: config.storage.s3Region,
      virtualHostedStyle: !config.storage.s3ForcePathStyle });
    const [object] = await sql`SELECT storage_path, sha256_hex FROM v4_storage_objects WHERE id=${prepared.object_id}`;
    const changed = new Uint8Array([1, 2, 3, 9]);
    await bucket.write(object.storage_path, changed);
    const stale = await app.request(blobPath, { headers: { Authorization: authHeader(blobPath, 'GET', ownerSecret) } });
    expect(stale.status).toBe(404);
    const metadataPath = `/api/v4/storage/${prepared.object_id}`;
    const fresh = await app.request(metadataPath, { headers: { Authorization: authHeader(metadataPath, 'GET', ownerSecret) } });
    expect((await fresh.json()).blossom_url).toBeNull();
    const [afterTamper] = await sql`SELECT sha256_hex FROM v4_storage_objects WHERE id=${prepared.object_id}`;
    expect(afterTamper.sha256_hex).toBe(object.sha256_hex);
    await bucket.delete(object.storage_path);
    const missing = await app.request(metadataPath, { headers: { Authorization: authHeader(metadataPath, 'GET', ownerSecret) } });
    expect((await missing.json()).blossom_url).toBeNull();

  });

  test('non-owner cannot prepare workspace-owned object', async () => {
    const preparePayload = JSON.stringify({
      owner_npub: WORKSPACE_NPUB,
      content_type: 'text/plain',
      file_name: 'unauthorized.txt',
    });

    const prepareRes = await app.request('/api/v4/storage/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/storage/prepare', 'POST', memberSecret, preparePayload),
      },
      body: preparePayload,
    });

    expect(prepareRes.status).toBe(403);
    const body = await prepareRes.json();
    expect(body.error).toContain('workspace owner');
  });

  s3StorageTest('group member can prepare and upload group-owned object', async () => {
    if (!await requireS3ForTest()) return;
    const preparePayload = JSON.stringify({
      owner_npub: WORKSPACE_NPUB,
      owner_group_id: GROUP_ID,
      content_type: 'image/png',
      size_bytes: 3,
      file_name: 'group-avatar.png',
      access_group_ids: [GROUP_ID],
    });

    const prepareRes = await app.request('/api/v4/storage/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/storage/prepare', 'POST', memberSecret, preparePayload),
      },
      body: preparePayload,
    });

    expect(prepareRes.status).toBe(200);
    const prepared = await prepareRes.json();
    expect(prepared.owner_group_id).toBe(GROUP_ID);
    expect(prepared.access_group_ids).toEqual([GROUP_ID]);

    const bytes = new Uint8Array([10, 20, 30]);
    const uploadPath = `/api/v4/storage/${prepared.object_id}`;
    const uploadPayload = JSON.stringify({
      base64_data: Buffer.from(bytes).toString('base64'),
    });
    const uploadRes = await app.request(uploadPath, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(uploadPath, 'PUT', memberSecret, uploadPayload),
      },
      body: uploadPayload,
    });
    expect(uploadRes.status).toBe(200);

    const completePath = `/api/v4/storage/${prepared.object_id}/complete`;
    const completePayload = JSON.stringify({
      sha256_hex: sha256Hex(bytes),
      size_bytes: bytes.byteLength,
    });
    const completeRes = await app.request(completePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(completePath, 'POST', memberSecret, completePayload),
      },
      body: completePayload,
    });
    expect(completeRes.status).toBe(200);
  });

  test('non-group-member cannot prepare group-owned object', async () => {
    const preparePayload = JSON.stringify({
      owner_npub: WORKSPACE_NPUB,
      owner_group_id: GROUP_ID,
      content_type: 'text/plain',
      file_name: 'outsider.txt',
    });

    const prepareRes = await app.request('/api/v4/storage/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/storage/prepare', 'POST', outsiderSecret, preparePayload),
      },
      body: preparePayload,
    });

    expect(prepareRes.status).toBe(403);
    const body = await prepareRes.json();
    expect(body.error).toContain('not a member');
  });

  s3StorageTest('group member can read object via access_group_ids', async () => {
    if (!await requireS3ForTest()) return;
    // Owner creates a group-owned object with access_group_ids
    const preparePayload = JSON.stringify({
      owner_npub: WORKSPACE_NPUB,
      owner_group_id: GROUP_ID,
      content_type: 'text/plain',
      size_bytes: 5,
      file_name: 'shared.txt',
      access_group_ids: [GROUP_ID],
    });

    const prepareRes = await app.request('/api/v4/storage/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/storage/prepare', 'POST', ownerSecret, preparePayload),
      },
      body: preparePayload,
    });
    expect(prepareRes.status).toBe(200);
    const prepared = await prepareRes.json();

    const bytes = new Uint8Array([5, 4, 3, 2, 1]);
    const uploadPath = `/api/v4/storage/${prepared.object_id}`;
    const uploadPayload = JSON.stringify({ base64_data: Buffer.from(bytes).toString('base64') });
    await app.request(uploadPath, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(uploadPath, 'PUT', ownerSecret, uploadPayload),
      },
      body: uploadPayload,
    });

    const completePath = `/api/v4/storage/${prepared.object_id}/complete`;
    const completePayload = JSON.stringify({ sha256_hex: sha256Hex(bytes), size_bytes: bytes.byteLength });
    await app.request(completePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(completePath, 'POST', ownerSecret, completePayload),
      },
      body: completePayload,
    });

    // Member reads via group membership
    const contentPath = `/api/v4/storage/${prepared.object_id}/content`;
    const contentRes = await app.request(contentPath, {
      headers: {
        Authorization: authHeader(contentPath, 'GET', memberSecret),
      },
    });
    expect(contentRes.status).toBe(200);
    const fetched = new Uint8Array(await contentRes.arrayBuffer());
    expect(Array.from(fetched)).toEqual([5, 4, 3, 2, 1]);

    // Outsider cannot read
    const outsiderRes = await app.request(contentPath, {
      headers: {
        Authorization: authHeader(contentPath, 'GET', outsiderSecret),
      },
    });
    expect(outsiderRes.status).toBe(404);
  });

  s3StorageTest('public objects are accessible without auth', async () => {
    if (!await requireS3ForTest()) return;
    const preparePayload = JSON.stringify({
      owner_npub: WORKSPACE_NPUB,
      content_type: 'image/png',
      size_bytes: 2,
      file_name: 'avatar.png',
      is_public: true,
      access_group_ids: [GROUP_ID],
    });

    const prepareRes = await app.request('/api/v4/storage/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/storage/prepare', 'POST', ownerSecret, preparePayload),
      },
      body: preparePayload,
    });
    expect(prepareRes.status).toBe(200);
    const prepared = await prepareRes.json();
    expect(prepared.is_public).toBe(true);

    const bytes = new Uint8Array([0xff, 0xd8]);
    const uploadPath = `/api/v4/storage/${prepared.object_id}`;
    const uploadPayload = JSON.stringify({ base64_data: Buffer.from(bytes).toString('base64') });
    await app.request(uploadPath, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(uploadPath, 'PUT', ownerSecret, uploadPayload),
      },
      body: uploadPayload,
    });

    const completePath = `/api/v4/storage/${prepared.object_id}/complete`;
    const completePayload = JSON.stringify({ sha256_hex: sha256Hex(bytes), size_bytes: bytes.byteLength });
    await app.request(completePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(completePath, 'POST', ownerSecret, completePayload),
      },
      body: completePayload,
    });

    // Access metadata without auth
    const metadataPath = `/api/v4/storage/${prepared.object_id}`;
    const metadataRes = await app.request(metadataPath);
    expect(metadataRes.status).toBe(200);
    const metadata = await metadataRes.json();
    expect(metadata.is_public).toBe(true);

    // Access content without auth
    const contentPath = `/api/v4/storage/${prepared.object_id}/content`;
    const contentRes = await app.request(contentPath);
    expect(contentRes.status).toBe(200);
    const fetched = new Uint8Array(await contentRes.arrayBuffer());
    expect(Array.from(fetched)).toEqual([0xff, 0xd8]);
    expect(contentRes.headers.get('cache-control')).toContain('public');

    // Download URL without auth
    const downloadUrlPath = `/api/v4/storage/${prepared.object_id}/download-url`;
    const downloadUrlRes = await app.request(downloadUrlPath);
    expect(downloadUrlRes.status).toBe(200);
  });

  test('S3 path includes group UUID for group-owned objects', async () => {
    const preparePayload = JSON.stringify({
      owner_npub: WORKSPACE_NPUB,
      owner_group_id: GROUP_ID,
      content_type: 'text/plain',
      file_name: 'path-test.txt',
    });

    const prepareRes = await app.request('/api/v4/storage/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/storage/prepare', 'POST', ownerSecret, preparePayload),
      },
      body: preparePayload,
    });
    expect(prepareRes.status).toBe(200);
    const prepared = await prepareRes.json();

    // Verify storage path in DB
    const [row] = await sql`SELECT storage_path FROM v4_storage_objects WHERE id = ${prepared.object_id}`;
    expect(row.storage_path).toContain(`v4/${WORKSPACE_NPUB}/${GROUP_ID}/`);
    expect(row.storage_path).toContain('path-test.txt');
  });

  test('S3 path does not include group UUID for workspace-owned objects', async () => {
    const preparePayload = JSON.stringify({
      owner_npub: WORKSPACE_NPUB,
      content_type: 'text/plain',
      file_name: 'ws-path-test.txt',
    });

    const prepareRes = await app.request('/api/v4/storage/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/storage/prepare', 'POST', ownerSecret, preparePayload),
      },
      body: preparePayload,
    });
    expect(prepareRes.status).toBe(200);
    const prepared = await prepareRes.json();

    const [row] = await sql`SELECT storage_path FROM v4_storage_objects WHERE id = ${prepared.object_id}`;
    expect(row.storage_path).toMatch(new RegExp(`^v4/${WORKSPACE_NPUB}/[^/]+-ws-path-test.txt$`));
  });

  test('prepare rejects invalid owner_npub (no matching workspace)', async () => {
    const preparePayload = JSON.stringify({
      owner_npub: 'npub1nonexistent',
      content_type: 'text/plain',
    });

    const prepareRes = await app.request('/api/v4/storage/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/storage/prepare', 'POST', ownerSecret, preparePayload),
      },
      body: preparePayload,
    });
    expect(prepareRes.status).toBe(403);
  });
});
