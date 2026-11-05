import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { nip19 } from 'nostr-tools';
import { exactObject, httpsOrigin, MAX_OBJECT_BYTES, requireCondition, StorageDelegationError, uuid } from './contract';

export interface StorageGrant {
  delegationId: string;
  revision: string;
  origin: string;
  serviceNpub: string;
  workspaceId: string;
  workspaceOwnerNpub: string;
  installationId: string;
  appId: string;
  appNpub: string;
  expiresAt: string;
  maxObjectBytes: number;
  quotaBytes: number;
  maxObjects: number;
  billing: 'operator_budget';
}
const fields = ['delegationId', 'revision', 'origin', 'serviceNpub', 'workspaceId', 'workspaceOwnerNpub',
  'installationId', 'appId', 'appNpub', 'expiresAt', 'maxObjectBytes', 'quotaBytes', 'maxObjects', 'billing'];
function npub(value: unknown): boolean {
  try { return typeof value === 'string' && nip19.decode(value).type === 'npub'; } catch { return false; }
}
export function parseStorageGrants(value: unknown): StorageGrant[] {
  try {
    const root = exactObject(value, ['version', 'grants']);
    requireCondition(root.version === 1 && Array.isArray(root.grants) && root.grants.length <= 100, 'storage_config_invalid', 503);
    const grants = root.grants.map((input): StorageGrant => {
      const row = exactObject(input, fields);
      requireCondition(fields.every(key => Object.hasOwn(row, key)), 'storage_config_invalid', 503);
      requireCondition(uuid.test(String(row.delegationId)) && uuid.test(String(row.workspaceId)), 'storage_config_invalid', 503);
      for (const key of ['revision', 'installationId', 'appId']) {
        requireCondition(typeof row[key] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(row[key]), 'storage_config_invalid', 503);
      }
      requireCondition(npub(row.serviceNpub) && npub(row.workspaceOwnerNpub) && npub(row.appNpub)
        && row.appNpub !== row.serviceNpub && row.appNpub !== row.workspaceOwnerNpub, 'storage_config_invalid', 503);
      httpsOrigin(row.origin);
      requireCondition(typeof row.expiresAt === 'string' && Number.isFinite(Date.parse(row.expiresAt)), 'storage_config_invalid', 503);
      requireCondition(Number.isSafeInteger(row.maxObjectBytes) && Number(row.maxObjectBytes) > 0 && Number(row.maxObjectBytes) <= MAX_OBJECT_BYTES
        && Number.isSafeInteger(row.quotaBytes) && Number(row.quotaBytes) >= Number(row.maxObjectBytes)
        && Number.isSafeInteger(row.maxObjects) && Number(row.maxObjects) > 0 && Number(row.maxObjects) <= 1_000_000,
      'storage_config_invalid', 503);
      requireCondition(row.billing === 'operator_budget', 'storage_billing_unconfigured', 409);
      return row as unknown as StorageGrant;
    });
    requireCondition(new Set(grants.map(g => g.delegationId)).size === grants.length
      && new Set(grants.map(g => g.appNpub)).size === grants.length
      && new Set(grants.map(g => `${g.installationId}:${g.appId}`)).size === grants.length, 'storage_config_invalid', 503);
    return grants;
  } catch (error) {
    if (error instanceof StorageDelegationError && error.code === 'storage_billing_unconfigured') throw error;
    throw new StorageDelegationError('storage_config_invalid', 503);
  }
}
export function readStorageGrants(path = process.env.MANAGED_APP_STORAGE_GRANTS_FILE): StorageGrant[] {
  if (!path) return [];
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    requireCondition(stat.isFile() && stat.size <= 128 * 1024 && (stat.mode & 0o077) === 0
      && stat.uid === process.geteuid?.(), 'storage_config_invalid', 503);
    return parseStorageGrants(JSON.parse(readFileSync(fd, 'utf8')));
  } catch (error) {
    if (error instanceof StorageDelegationError) throw error;
    throw new StorageDelegationError('storage_config_invalid', 503);
  } finally { if (fd !== undefined) closeSync(fd); }
}
