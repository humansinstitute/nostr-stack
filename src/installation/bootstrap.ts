import { mkdir, readFile, writeFile, link, unlink, rename, chmod, copyFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  isBundledMinioEndpoint,
  isBundledSeaweedfsEndpoint,
} from '../services/storage-provider';
import {
  parseSetupStorageProviderFile,
  resolveBootstrapStorageProvider,
  SETUP_STORAGE_PROVIDER_FILE,
  type SetupStorageProviderRecord,
} from './setup-storage-provider';

export const SETUP_SEAWEEDFS_APP_CREDS_FILE = 'storage-seaweedfs-app.json';
export const SETUP_STORAGE_ADMIN_CREDS_FILE = 'storage-admin.json';

const UNSAFE_SHELL_OR_CONTROL_RE = /[\x00-\x1f\x7f\s'"`$;|&<>\\]/;

export function validateSafeExternalS3Endpoint(raw: string | null | undefined): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    throw new Error('STORAGE_S3_ENDPOINT must be set for external-s3 setup');
  }
  if (UNSAFE_SHELL_OR_CONTROL_RE.test(trimmed)) {
    throw new Error('STORAGE_S3_ENDPOINT contains unsafe control, whitespace, or shell characters');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid STORAGE_S3_ENDPOINT URL: ${trimmed}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('STORAGE_S3_ENDPOINT must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('STORAGE_S3_ENDPOINT must not contain embedded credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('STORAGE_S3_ENDPOINT must not contain query parameters or fragments');
  }
  if (isBundledMinioEndpoint(trimmed) || isBundledSeaweedfsEndpoint(trimmed)) {
    throw new Error('STORAGE_S3_ENDPOINT for external-s3 must not target bundled minio or seaweedfs');
  }
  return trimmed;
}

function serializeEnvAssignment(key: string, value: string): string {
  if (!/^[A-Z0-9_]+$/.test(key)) {
    throw new Error(`Invalid runtime.env key: ${key}`);
  }
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`Unsafe control characters in runtime.env value for ${key}`);
  }
  if (value === '' || /^[A-Za-z0-9_./:@+-]+$/.test(value)) {
    return `${key}=${value}`;
  }
  // Defense-in-depth POSIX single-quoting (never allows shell expansion or splitting).
  return `${key}='${value.replace(/'/g, "'\\''")}'`;
}

/** Write once without exposing a partial destination to concurrent starters. */
export async function writeOnce(path: string, contents: string): Promise<boolean> {
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally { await unlink(temporary); }
}

async function atomicWrite(path: string, contents: string, mode = 0o600): Promise<void> {
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  await writeFile(temporary, contents, { mode, flag: 'wx' });
  await rename(temporary, path);
}

async function readOptionalProviderRecord(directory: string): Promise<SetupStorageProviderRecord | null> {
  const path = join(directory, SETUP_STORAGE_PROVIDER_FILE);
  try {
    const raw = await readFile(path, 'utf8');
    return parseSetupStorageProviderFile(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export interface StorageAppCredentials {
  version: 1;
  access_key: string;
  secret_key: string;
}

export interface StorageAdminCredentials {
  version: 1;
  admin_access_key: string;
  admin_secret_key: string;
}

/**
 * Durable SeaweedFS app credentials live in the bootstrap volume so updates/restarts
 * after a MinIO -> SeaweedFS setup migration preserve the rotated SeaweedFS app keys
 * without mutating bootstrap.json or reverting to legacy MinIO credentials.
 */
async function ensureSeaweedfsAppCredentials(
  directory: string,
  initialAccessKey: string,
  initialSecretKey: string,
  requireDistinctFrom?: string,
): Promise<StorageAppCredentials> {
  const path = join(directory, SETUP_SEAWEEDFS_APP_CREDS_FILE);
  let candidateAccess = initialAccessKey;
  let candidateSecret = initialSecretKey;
  if (requireDistinctFrom && candidateAccess === requireDistinctFrom) {
    do {
      candidateAccess = randomBytes(16).toString('hex');
    } while (candidateAccess === requireDistinctFrom);
    candidateSecret = randomBytes(32).toString('hex');
  }
  await writeOnce(
    path,
    JSON.stringify({ version: 1, access_key: candidateAccess, secret_key: candidateSecret }),
  );
  const saved = JSON.parse(await readFile(path, 'utf8')) as StorageAppCredentials;
  if (
    saved.version !== 1 ||
    !/^[a-f0-9]{32}$/.test(saved.access_key) ||
    !/^[a-f0-9]{64}$/.test(saved.secret_key)
  ) {
    throw new Error('Invalid protected SeaweedFS app credentials; refusing regeneration');
  }
  return saved;
}

/**
 * Init/admin credentials live EXCLUSIVELY in the storage-credentials volume
 * (mounted only by bootstrap, seaweedfs, and seaweedfs-init — NEVER mounted by Tower).
 */
export async function ensureStorageAdminCredentials(
  storageCredentialsDirectory: string,
  appAccessKey: string,
): Promise<StorageAdminCredentials> {
  await mkdir(storageCredentialsDirectory, { recursive: true, mode: 0o755 });
  const path = join(storageCredentialsDirectory, SETUP_STORAGE_ADMIN_CREDS_FILE);
  let accessKey = randomBytes(16).toString('hex');
  while (accessKey === appAccessKey) accessKey = randomBytes(16).toString('hex');
  const candidate: StorageAdminCredentials = {
    version: 1,
    admin_access_key: accessKey,
    admin_secret_key: randomBytes(32).toString('hex'),
  };
  await writeOnce(path, JSON.stringify(candidate));
  const saved = JSON.parse(await readFile(path, 'utf8')) as StorageAdminCredentials;
  if (
    saved.version !== 1 ||
    !/^[a-f0-9]{32}$/.test(saved.admin_access_key) ||
    !/^[a-f0-9]{64}$/.test(saved.admin_secret_key) ||
    saved.admin_access_key === appAccessKey
  ) {
    throw new Error('Invalid protected storage admin credentials; refusing regeneration');
  }
  return saved;
}

export async function initializeInstallation(
  directory: string,
  options: {
    requestedProvider?: string | null;
    externalS3Endpoint?: string | null;
    storageCredentialsDirectory?: string | null;
  } = {},
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const existingProviderDoc = await readOptionalProviderRecord(directory);
  const bootstrapPath = join(directory, 'bootstrap.json');
  let bootstrapExistedBefore = false;
  try {
    await readFile(bootstrapPath, 'utf8');
    bootstrapExistedBefore = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  // Validate storage provider AND external-s3 endpoint BEFORE creating or modifying any bootstrap state so conflicts fail closed.
  const provider = resolveBootstrapStorageProvider({
    bootstrapExisted: bootstrapExistedBefore,
    existingProviderDoc,
    requestedProvider: options.requestedProvider ?? process.env.NSTACK_SETUP_STORAGE_PROVIDER,
  });
  let validatedExternalEndpoint: string | null = null;
  if (provider === 'external-s3') {
    validatedExternalEndpoint = validateSafeExternalS3Endpoint(
      options.externalS3Endpoint ?? process.env.STORAGE_S3_ENDPOINT,
    );
  }

  const secret = generateSecretKey();
  const state = {
    version: 1,
    database_password: randomBytes(32).toString('hex'),
    storage_access_key: randomBytes(16).toString('hex'),
    storage_secret_key: randomBytes(32).toString('hex'),
    service_nsec: nip19.nsecEncode(secret),
    service_npub: nip19.npubEncode(getPublicKey(secret)),
    // A distinct namespace identity; does not register or consent to an app.
    console_app_npub: nip19.npubEncode(getPublicKey(generateSecretKey())),
    claim_code: randomBytes(24).toString('hex'),
  };
  await writeOnce(bootstrapPath, JSON.stringify(state));
  const saved = JSON.parse(await readFile(bootstrapPath, 'utf8')) as typeof state;
  if (saved.version !== 1) throw new Error('Unsupported installation state');
  if(!/^[a-f0-9]{64}$/.test(saved.database_password)||!/^[a-f0-9]{32}$/.test(saved.storage_access_key)||!/^[a-f0-9]{64}$/.test(saved.storage_secret_key)||!/^[a-f0-9]{48}$/.test(saved.claim_code))throw Error('Invalid protected bootstrap state; refusing regeneration');
  const decoded=nip19.decode(saved.service_nsec);
  if(decoded.type!=='nsec'||nip19.npubEncode(getPublicKey(decoded.data))!==saved.service_npub)throw Error('Invalid protected service identity');
  const app=nip19.decode(saved.console_app_npub);if(app.type!=='npub')throw Error('Invalid console namespace');

  // Persist durable storage provider selection alongside bootstrap.json (write-once; migration updates it explicitly).
  await writeOnce(
    join(directory, SETUP_STORAGE_PROVIDER_FILE),
    `${JSON.stringify({ version: 1, provider })}\n`,
  );
  const verifiedProvider = parseSetupStorageProviderFile(
    await readFile(join(directory, SETUP_STORAGE_PROVIDER_FILE), 'utf8'),
  ).provider;
  if (verifiedProvider !== provider) {
    throw new Error(`Concurrent ${SETUP_STORAGE_PROVIDER_FILE} mismatch (${verifiedProvider} vs ${provider})`);
  }

  let s3Endpoint = 'http://seaweedfs:8333';
  let activeAccessKey = saved.storage_access_key;
  let activeSecretKey = saved.storage_secret_key;
  if (provider === 'seaweedfs') {
    // On an existing installation migrating from MinIO (bootstrap.json existed before
    // storage-seaweedfs-app.json), require distinct credentials so MinIO keys are never reused.
    const sfsApp = await ensureSeaweedfsAppCredentials(
      directory,
      saved.storage_access_key,
      saved.storage_secret_key,
      bootstrapExistedBefore ? saved.storage_access_key : undefined,
    );
    activeAccessKey = sfsApp.access_key;
    activeSecretKey = sfsApp.secret_key;
  } else if (provider === 'minio') {
    s3Endpoint = 'http://minio:9000';
  } else if (provider === 'external-s3') {
    s3Endpoint = validatedExternalEndpoint!;
  }

  // Keep admin credentials strictly out of the Tower-mounted bootstrap directory.
  let storageAdmin: StorageAdminCredentials | null = null;
  if (provider === 'seaweedfs' && options.storageCredentialsDirectory) {
    storageAdmin = await ensureStorageAdminCredentials(
      options.storageCredentialsDirectory,
      activeAccessKey,
    );
  }

  // Values are strictly validated hex/bech32, fixed provider constants, or sanitized safe URLs.
  const assignments: Record<string, string> = {
    NSTACK_SETUP_DIRECTORY: '/run/nstack',
    DB_HOST: 'postgres', DB_NAME: 'nstack', DB_USER: 'nstack', DB_PASSWORD: saved.database_password,
    STORAGE_PROVIDER: provider,
    STORAGE_S3_ENDPOINT: s3Endpoint,
    STORAGE_S3_ENDPOINT_PUBLIC: '',
    STORAGE_S3_ACCESS_KEY: activeAccessKey,
    STORAGE_S3_SECRET_KEY: activeSecretKey,
    STORAGE_S3_BUCKET: 'nstack',
    STORAGE_REQUIRE_SENTINEL: provider === 'seaweedfs' ? 'true' : 'false',
    SUPERBASED_SERVICE_NSEC: saved.service_nsec,
    SUPERBASED_SERVICE_NPUB: saved.service_npub,
    FLIGHT_DECK_PG_APP_NPUB: saved.console_app_npub,
  };
  await atomicWrite(
    join(directory, 'runtime.env'),
    Object.entries(assignments).map(([k, v]) => serializeEnvAssignment(k, v)).join('\n') + '\n',
  );
  return {
    service_npub: saved.service_npub,
    storage_provider: provider,
    storage_access_key: activeAccessKey,
    storage_secret_key: activeSecretKey,
    storage_admin: storageAdmin,
  };
}

if (import.meta.main) {
  if(process.env.NSTACK_UNSUPPORTED_OVERRIDES)throw Error('Generated-install credentials cannot be overridden. Use the existing env deployment or a reviewed explicit adoption; bootstrap unchanged.');
  const directory = process.env.NSTACK_SETUP_DIRECTORY || '/run/nstack';
  const dbCredentialsDir = process.env.NSTACK_DB_CREDENTIALS_DIR || '/run/nstack-db';
  const storageCredentialsDir = process.env.NSTACK_STORAGE_CREDENTIALS_DIR || '/run/nstack-storage';
  const result = await initializeInstallation(directory, {
    storageCredentialsDirectory: storageCredentialsDir,
  });
  const state = JSON.parse(await readFile(join(directory, 'bootstrap.json'), 'utf8'));
  const storageValues: Record<string, string> = {
    STORAGE_PROVIDER: result.storage_provider,
    STORAGE_S3_ACCESS_KEY: result.storage_access_key,
    STORAGE_S3_SECRET_KEY: result.storage_secret_key,
    STORAGE_S3_BUCKET: 'nstack',
  };
  if (result.storage_admin) {
    storageValues.SEAWEEDFS_ADMIN_ACCESS_KEY = result.storage_admin.admin_access_key;
    storageValues.SEAWEEDFS_ADMIN_SECRET_KEY = result.storage_admin.admin_secret_key;
  }

  await mkdir(dbCredentialsDir, { recursive: true, mode: 0o700 });
  await chmod(dbCredentialsDir, 0o700);
  await writeOnce(
    join(dbCredentialsDir, 'runtime.env'),
    Object.entries({ DB_USER: 'nstack', DB_NAME: 'nstack', DB_PASSWORD: state.database_password })
      .map(([k, v]) => `${k}=${v}`).join('\n') + '\n',
  );

  // Storage volume is mounted ONLY by bootstrap, seaweedfs/minio, and storage-init (never Tower).
  // Non-root seaweedfs (uid 1000) reads runtime.env and render-seaweedfs-config.sh from this exclusive volume.
  await mkdir(storageCredentialsDir, { recursive: true, mode: 0o755 });
  await chmod(storageCredentialsDir, 0o755);
  await atomicWrite(
    join(storageCredentialsDir, 'runtime.env'),
    Object.entries(storageValues).map(([k, v]) => `${k}=${v}`).join('\n') + '\n',
    0o644,
  );

  // Stage SeaweedFS config renderer into the storage-credentials volume so setup SeaweedFS needs zero host bind mounts.
  const rendererSrc = fileURLToPath(new URL('../../deploy/nstack/render-seaweedfs-config.sh', import.meta.url));
  const rendererTmp = join(storageCredentialsDir, `render-seaweedfs-config.${randomBytes(8).toString('hex')}.tmp`);
  await copyFile(rendererSrc, rendererTmp);
  await chmod(rendererTmp, 0o755);
  await rename(rendererTmp, join(storageCredentialsDir, 'render-seaweedfs-config.sh'));

  console.log(`NStack bootstrap ready (storage_provider=${result.storage_provider}). Retrieve the one-time claim code locally with the documented setup command.`);
}
