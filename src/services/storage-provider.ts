export type StorageProvider = 'seaweedfs' | 'minio' | 'external-s3';

export interface ResolvedStorageProviderConfig {
  provider: StorageProvider;
  explicit: boolean;
  endpoint: string;
}

const VALID_PROVIDERS = new Set<StorageProvider>(['seaweedfs', 'minio', 'external-s3']);
const BUNDLED_MINIO_HOSTS = new Set(['minio', 'wingman-tower-minio']);
const BUNDLED_SEAWEEDFS_HOSTS = new Set(['seaweedfs', 'wingman-tower-seaweedfs']);

export function parseEndpointHost(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`Invalid STORAGE_S3_ENDPOINT URL: ${endpoint}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`STORAGE_S3_ENDPOINT must use http or https: ${endpoint}`);
  }
  return parsed.hostname.toLowerCase();
}

export function isBundledMinioEndpoint(endpoint: string): boolean {
  return BUNDLED_MINIO_HOSTS.has(parseEndpointHost(endpoint));
}

export function isBundledSeaweedfsEndpoint(endpoint: string): boolean {
  return BUNDLED_SEAWEEDFS_HOSTS.has(parseEndpointHost(endpoint));
}

/**
 * Resolve storage provider selection with backwards-compatible inference:
 * - When STORAGE_PROVIDER is unset: infer `minio` if STORAGE_S3_ENDPOINT is unset or
 *   names the bundled `minio` service; otherwise `external-s3` passthrough.
 * - When STORAGE_PROVIDER is explicitly set: validate the value and fail closed
 *   if it conflicts with the configured endpoint.
 */
export function resolveStorageProviderConfig(
  env: Record<string, string | undefined> = process.env,
): ResolvedStorageProviderConfig {
  const rawProvider = String(env.STORAGE_PROVIDER || '').trim().toLowerCase();
  const rawEndpoint = String(env.STORAGE_S3_ENDPOINT || '').trim();
  const defaultMinioEndpoint =
    String(env.STORAGE_S3_DEFAULT_MINIO_ENDPOINT || '').trim() || 'http://127.0.0.1:9000';

  if (!rawProvider) {
    if (!rawEndpoint) {
      return {
        provider: 'minio',
        explicit: false,
        endpoint: defaultMinioEndpoint,
      };
    }
    const host = parseEndpointHost(rawEndpoint);
    if (BUNDLED_MINIO_HOSTS.has(host)) {
      return {
        provider: 'minio',
        explicit: false,
        endpoint: rawEndpoint,
      };
    }
    return {
      provider: 'external-s3',
      explicit: false,
      endpoint: rawEndpoint,
    };
  }

  if (!VALID_PROVIDERS.has(rawProvider as StorageProvider)) {
    throw new Error(
      `Invalid STORAGE_PROVIDER "${rawProvider}". Expected one of: seaweedfs, minio, external-s3.`,
    );
  }

  const provider = rawProvider as StorageProvider;
  if (provider === 'external-s3') {
    if (!rawEndpoint) {
      throw new Error('STORAGE_S3_ENDPOINT must be set when STORAGE_PROVIDER=external-s3.');
    }
    const host = parseEndpointHost(rawEndpoint);
    if (BUNDLED_MINIO_HOSTS.has(host) || BUNDLED_SEAWEEDFS_HOSTS.has(host)) {
      throw new Error(
        `STORAGE_PROVIDER=external-s3 conflicts with bundled storage endpoint "${rawEndpoint}".`,
      );
    }
    return { provider, explicit: true, endpoint: rawEndpoint };
  }

  const endpoint =
    rawEndpoint || (provider === 'seaweedfs' ? 'http://seaweedfs:8333' : defaultMinioEndpoint);
  const host = parseEndpointHost(endpoint);

  if (provider === 'seaweedfs' && BUNDLED_MINIO_HOSTS.has(host)) {
    throw new Error(
      `STORAGE_PROVIDER=seaweedfs conflicts with bundled MinIO endpoint "${endpoint}".`,
    );
  }
  if (provider === 'minio' && BUNDLED_SEAWEEDFS_HOSTS.has(host)) {
    throw new Error(
      `STORAGE_PROVIDER=minio conflicts with bundled SeaweedFS endpoint "${endpoint}".`,
    );
  }

  return { provider, explicit: true, endpoint };
}

/**
 * Determine compose profiles for production deploys without reviving MinIO after migration.
 * Explicit COMPOSE_PROFILES wins only when it does not conflict with explicit STORAGE_PROVIDER.
 */
export function resolveProdComposeProfiles(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const resolved = resolveStorageProviderConfig(env);
  const explicitProfiles = String(env.COMPOSE_PROFILES || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  if (explicitProfiles.length > 0) {
    if (resolved.explicit) {
      if (resolved.provider === 'seaweedfs' && explicitProfiles.includes('minio') && !explicitProfiles.includes('seaweedfs')) {
        throw new Error('COMPOSE_PROFILES enables minio without seaweedfs while STORAGE_PROVIDER=seaweedfs.');
      }
      if (resolved.provider === 'minio' && explicitProfiles.includes('seaweedfs') && !explicitProfiles.includes('minio')) {
        throw new Error('COMPOSE_PROFILES enables seaweedfs without minio while STORAGE_PROVIDER=minio.');
      }
    }
    return [...new Set(explicitProfiles)];
  }

  if (resolved.provider === 'seaweedfs') return ['seaweedfs'];
  if (resolved.provider === 'minio') return ['minio'];
  return [];
}
