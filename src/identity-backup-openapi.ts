const object = (properties: Record<string, unknown>, optional: string[] = []) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties).filter(k => !optional.includes(k)), properties });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const ok = (schema: unknown, description = 'Hosted identity backup result') => ({ description, content: { 'application/json': { schema } } });
const username = { name: 'username', in: 'path', required: true, schema: { type: 'string', description: 'NFKC + lowercase; ^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$' } };
const err = (description: string) => ({ description, content: { 'application/json': { schema: object({ code: { type: 'string' }, error: { type: 'string' }, current_revision: { type: 'string' } }, ['current_revision']) } } });
export const identityBackupSchemas = {
  IdentityBackupPut: object({ ncryptsec: { type: 'string', minLength: 162, maxLength: 162, pattern: '^ncryptsec1[02-9ac-hj-np-z]+$', description: 'NIP-49 ciphertext only; logN 16-18. The server never receives a password or plaintext key and cannot verify decryptability.' }, expected_revision: { type: 'string', pattern: '^(0|[1-9][0-9]*)$', description: '"0" creates; otherwise the current revision (compare-and-swap).' } }),
  IdentityBackupWritten: object({ username: { type: 'string' }, revision: { type: 'string' }, updated_at: { type: 'string', format: 'date-time' }, created: { type: 'boolean' } }),
  IdentityBackupPublic: object({ username: { type: 'string' }, ncryptsec: { type: 'string' }, revision: { type: 'string' }, updated_at: { type: 'string', format: 'date-time' } }),
  IdentityBackupOwn: object({ username: { type: 'string' }, revision: { type: 'string' }, updated_at: { type: 'string', format: 'date-time' } }),
};
export const identityBackupPaths: Record<string, any> = {
  '/api/v4/identity-backup/{username}': {
    put: { summary: 'Create or compare-and-swap a hosted ncryptsec backup (strict NIP-98, signed directly by the owner key)', tags: ['Identity backup'], parameters: [username],
      requestBody: { required: true, content: { 'application/json': { schema: ref('IdentityBackupPut') } } },
      responses: { '200': ok(ref('IdentityBackupWritten')), '201': ok(ref('IdentityBackupWritten')), '400': err('invalid_username | invalid_backup | invalid_body'), '401': err('NIP-98 required'), '403': err('backup_owner_mismatch'), '409': err('username_unavailable | identity_already_backed_up | revision_conflict'), '429': err('rate_limited') } },
    get: { summary: 'Public ciphertext and revision by username. Returns no npub; username existence is enumerable (bounded by throttles).', tags: ['Identity backup'], parameters: [username],
      responses: { '200': ok(ref('IdentityBackupPublic')), '404': err('backup_not_found'), '429': err('rate_limited') } },
  },
  '/api/v4/identity-backup/me': { get: { summary: 'Signer proves a durable hosted copy exists (no ciphertext)', tags: ['Identity backup'], responses: { '200': ok(ref('IdentityBackupOwn')), '401': err('NIP-98 required'), '404': err('backup_not_found'), '429': err('rate_limited') } } },
};
