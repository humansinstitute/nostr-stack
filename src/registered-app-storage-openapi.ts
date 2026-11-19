const base = '/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/storage';
const identity = { size_bytes: { type: 'integer', minimum: 1, maximum: 8388608 }, sha256_hex: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' } };
const metadata = { type: 'object', additionalProperties: false, required: ['protocol', 'workspace_owner_npub', 'app_npub', 'object_id', 'file_name', 'content_type', 'size_bytes', 'sha256_hex', 'is_public', 'completed_at'], properties: {
  protocol: { type: 'string', enum: ['registered-app-storage-v1'] }, workspace_owner_npub: { type: 'string' }, app_npub: { type: 'string' }, object_id: { type: 'string', format: 'uuid' }, file_name: { type: 'string' }, content_type: { type: 'string' }, ...identity,
  is_public: { type: 'boolean', enum: [false] }, completed_at: { type: 'string', format: 'date-time', nullable: true },
} };
function operation(summary: string, object: boolean, properties?: Record<string, unknown>, response: unknown = metadata, status = '200') {
  return { tags: ['Registered app storage'], summary, description: 'Exact raw NIP-98 app signer and enabled owner-approved registration required on every operation. No workspace membership required. Private only; no provider URLs or publication capability. Registration revocation applies to every app request.',
    security: [{ nip98: [] }], parameters: [...['workspaceOwnerNpub', 'appNpub', ...(object ? ['objectId'] : [])].map(name => ({ name, in: 'path', required: true, schema: { type: 'string', ...(name === 'objectId' ? { format: 'uuid' } : {}) } }))],
    ...(properties ? { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties } } } } } : {}),
    responses: { [status]: { description: 'Success; private, no-store', content: { 'application/json': { schema: response } } }, '400': { description: 'Invalid body or identity' }, '401': { description: 'Invalid NIP-98' }, '403': { description: 'Wrong raw signer' }, '404': { description: 'Unknown/disabled registration, workspace, or foreign object' }, '409': { description: 'Identity/idempotency mismatch, incomplete or immutable object' }, '402': { description: 'Workspace credit or hosting balance exhausted' }, '408': { description: 'Body read interrupted or exceeded 15 seconds' }, '413': { description: 'JSON envelope exceeds 12 MiB' } },
  };
}
const content = (head: boolean) => ({ ...operation(head ? 'Private object content headers' : 'Read verified private bytes', true), responses: {
  '200': { description: 'Verified content; Cache-Control: private, no-store; Content-Type and Content-Length match metadata', ...(head ? {} : { content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }) },
  '401': { description: 'Invalid NIP-98' }, '403': { description: 'Wrong raw signer' }, '404': { description: 'Object unavailable' }, '409': { description: 'Incomplete or stored identity mismatch' },
} });
export const registeredAppStoragePaths = {
  [`${base}/descriptor`]: { get: operation('Discover registered-app-storage-v1', false, undefined, { type: 'object', required: ['protocol', 'workspace_owner_npub', 'app_npub', 'max_object_bytes', 'private_only', 'operations'], properties: {
    protocol: { type: 'string', enum: ['registered-app-storage-v1'] }, workspace_owner_npub: { type: 'string' }, app_npub: { type: 'string' }, max_object_bytes: { type: 'integer', enum: [8388608] }, private_only: { type: 'boolean', enum: [true] }, operations: { type: 'array', items: { type: 'string', enum: ['prepare', 'upload', 'complete', 'metadata', 'content', 'head'] } },
  } }) },
  [`${base}/prepare`]: { post: operation('Prepare or replay private object', false, { idempotency_key: { type: 'string', format: 'uuid' }, file_name: { type: 'string', minLength: 1, maxLength: 255 }, content_type: { type: 'string', maxLength: 255 }, ...identity }, metadata, '201') },
  [`${base}/objects/{objectId}`]: { get: operation('Read private object metadata', true), put: operation('Upload canonical base64 matching prepared identity (12 MiB envelope)', true, { base64_data: { type: 'string', maxLength: 11184812 } }) },
  [`${base}/objects/{objectId}/complete`]: { post: operation('Verify stored hash and size; exact repeat idempotent', true, identity) },
  [`${base}/objects/{objectId}/content`]: { get: content(false), head: content(true) },
};
