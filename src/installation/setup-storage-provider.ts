import type { StorageProvider } from '../services/storage-provider';

export const SETUP_STORAGE_PROVIDER_FILE = 'storage-provider.json';
export const SEAWEEDFS_PINNED_IMAGE =
  'chrislusf/seaweedfs@sha256:7ca46aeae2f223b37e5d91593c17ab37738eec6df6ab69b48a0487f7643342b9';
export const MINIO_CACHED_PINNED_IMAGE =
  'minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e';

export interface SetupStorageProviderRecord {
  version: 1;
  provider: StorageProvider;
}

const VALID_PROVIDERS = new Set<StorageProvider>(['seaweedfs', 'minio', 'external-s3']);

export function parseSetupStorageProviderFile(raw: string): SetupStorageProviderRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ${SETUP_STORAGE_PROVIDER_FILE}: malformed JSON. Refusing startup without modifying installation state.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ${SETUP_STORAGE_PROVIDER_FILE}: expected JSON object.`);
  }
  const obj = parsed as Record<string, unknown>;
  const provider = String(obj.provider || '').trim().toLowerCase() as StorageProvider;
  if (obj.version !== 1 || !VALID_PROVIDERS.has(provider)) {
    throw new Error(
      `Invalid ${SETUP_STORAGE_PROVIDER_FILE}: expected {"version":1,"provider":"seaweedfs"|"minio"|"external-s3"}.`,
    );
  }
  return { version: 1, provider };
}

export function normalizeRequestedSetupProvider(value: string | null | undefined): StorageProvider | null {
  const trimmed = String(value || '').trim().toLowerCase();
  if (!trimmed) return null;
  if (!VALID_PROVIDERS.has(trimmed as StorageProvider)) {
    throw new Error(
      `Unsupported NSTACK_SETUP_STORAGE_PROVIDER "${trimmed}". Expected seaweedfs, minio, or external-s3.`,
    );
  }
  return trimmed as StorageProvider;
}

/**
 * Resolve durable storage provider inside setup bootstrap.
 * Never silently switches an existing installation or regenerates identity/claim secrets on conflict.
 */
export function resolveBootstrapStorageProvider(options: {
  bootstrapExisted: boolean;
  existingProviderDoc: SetupStorageProviderRecord | null;
  requestedProvider?: string | null;
}): StorageProvider {
  const requested = normalizeRequestedSetupProvider(options.requestedProvider);

  if (options.existingProviderDoc) {
    if (requested && requested !== options.existingProviderDoc.provider) {
      throw new Error(
        `Storage provider conflict: installation is pinned to "${options.existingProviderDoc.provider}" in ${SETUP_STORAGE_PROVIDER_FILE}, but "${requested}" was requested. Use explicit migration (nstack:migrate-storage) to change providers; installation identity and credentials were left unchanged.`,
      );
    }
    return options.existingProviderDoc.provider;
  }

  if (options.bootstrapExisted) {
    if (requested && requested !== 'minio') {
      throw new Error(
        `Storage provider conflict: existing bootstrap.json without ${SETUP_STORAGE_PROVIDER_FILE} belongs to a MinIO installation, but "${requested}" was requested. Keep minio on update or run explicit migration; bootstrap state was left unchanged.`,
      );
    }
    return 'minio';
  }

  return requested ?? 'seaweedfs';
}

export interface SetupProjectVolumeState {
  hasBootstrapVolume: boolean;
  hasMinioStorageVolume: boolean;
  hasSeaweedfsStorageVolume: boolean;
  providerFile: SetupStorageProviderRecord | null;
  requestedProvider?: string | null;
}

/**
 * Host-side detection for `scripts/nstack-start.ts` before pulling/building/starting Compose services.
 * Fails closed on ambiguous volume layouts without modifying volumes or regenerating identity.
 */
export function detectSetupProjectStorageProvider(state: SetupProjectVolumeState): StorageProvider {
  const requested = normalizeRequestedSetupProvider(state.requestedProvider);

  if (state.providerFile) {
    if (requested && requested !== state.providerFile.provider) {
      throw new Error(
        `Storage provider conflict: project ${SETUP_STORAGE_PROVIDER_FILE} declares "${state.providerFile.provider}", but "${requested}" was requested. Refusing to start or alter installation state.`,
      );
    }
    return state.providerFile.provider;
  }

  if (!state.hasBootstrapVolume && !state.hasMinioStorageVolume && !state.hasSeaweedfsStorageVolume) {
    return requested ?? 'seaweedfs';
  }

  if (!state.hasBootstrapVolume && (state.hasMinioStorageVolume || state.hasSeaweedfsStorageVolume)) {
    throw new Error(
      'Ambiguous installation state: storage volume exists without a matching bootstrap volume. Refusing to start or regenerate identity/claim secrets; inspect project volumes explicitly.',
    );
  }

  if (state.hasMinioStorageVolume && state.hasSeaweedfsStorageVolume) {
    throw new Error(
      `Ambiguous installation state: both legacy "storage" (MinIO) and "storage-seaweedfs" volumes exist without ${SETUP_STORAGE_PROVIDER_FILE}. Refusing to start without explicit migration state; existing volumes and identity are preserved.`,
    );
  }

  if (state.hasMinioStorageVolume) {
    if (requested && requested !== 'minio') {
      throw new Error(
        `Storage provider conflict: existing MinIO "storage" volume detected without ${SETUP_STORAGE_PROVIDER_FILE}, but "${requested}" was requested. Refusing to switch providers automatically.`,
      );
    }
    return 'minio';
  }

  if (state.hasSeaweedfsStorageVolume) {
    if (requested && requested !== 'seaweedfs') {
      throw new Error(
        `Storage provider conflict: existing "storage-seaweedfs" volume detected, but "${requested}" was requested. Refusing to switch providers automatically.`,
      );
    }
    return 'seaweedfs';
  }

  throw new Error(
    `Ambiguous installation state: bootstrap volume exists without ${SETUP_STORAGE_PROVIDER_FILE} or a storage volume. Refusing to guess provider; inspect the installation before retrying.`,
  );
}
