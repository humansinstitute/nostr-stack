const uuid = { type: 'string', format: 'uuid' };
const dec = { type: 'string', pattern: '^(0|[1-9][0-9]*)$', description: 'Non-negative integer as a decimal string.' };
const object = (properties: Record<string, unknown>, optional: string[] = []) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties).filter(k => !optional.includes(k)), properties });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ required: true, content: { 'application/json': { schema } } });
const ok = (schema: unknown, description = 'Agent holds result') => ({ description, content: { 'application/json': { schema } } });
const npub = { type: 'string', pattern: '^npub1[02-9ac-hj-np-z]{58}$' };
const call = { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,128}$', description: 'Stable idempotency key of one logical model call.' };
const errors = { '400': { description: 'Invalid body' }, '401': { description: 'Strict NIP-98 required' }, '402': { description: 'Insufficient agent-available funds' }, '403': { description: 'Not authorized: service not allowlisted, no matching grant, or not the payer/admin' }, '404': { description: 'Unknown or foreign hold/grant' }, '409': { description: 'Idempotency, cap, spend block, not-proven release or settlement conflict' }, '422': { description: 'Model not priced, token bound exceeded or cached rate unsupported' }, '503': { description: 'Disabled, or storage coverage incomplete' } };
export const agentHoldsSchemas = {
  AgentHold: object({ hold_id: uuid, account_id: uuid, call_id: call, grant_id: uuid, state: { enum: ['held', 'dispatched', 'pending_reconcile', 'settled', 'released'] }, model: { type: 'string' }, tariff_version: { type: 'string' },
    reserved_units: dec, reserved_at: { type: 'string', format: 'date-time' }, reconcile_by: { type: 'string', format: 'date-time', description: 'Reminder label only; never an expiry or release.' }, day: { type: 'string' },
    settled_units: { type: ['string', 'null'] }, overrun_units: dec, release_basis: { enum: ['never_dispatched', 'provider_rejection', null] }, pending_reason: { type: ['string', 'null'] } }),
  AgentHoldReserveRequest: object({ account_id: uuid, call_id: call, grant_id: uuid, workspace_id: uuid, agent_npub: npub, model: { type: 'string' }, tariff_version: { type: 'string' }, max_input_tokens: dec, max_output_tokens: dec, max_cached_input_tokens: dec, run_id: { type: 'string', maxLength: 128 } }, ['max_cached_input_tokens', 'run_id']),
  AgentHoldIdentity: object({ account_id: uuid, call_id: call }),
  AgentHoldPendingRequest: object({ account_id: uuid, call_id: call, reason: { type: 'string', maxLength: 300 } }),
  AgentHoldReleaseRequest: object({ account_id: uuid, call_id: call, basis: { enum: ['never_dispatched', 'provider_rejection'] }, evidence: object({ provider: { type: 'string' }, http_status: { type: 'string' }, error_code: { type: 'string' }, request_id: { type: 'string' } }, ['request_id']) }, ['evidence']),
  AgentHoldSettleRequest: object({ account_id: uuid, call_id: call, observation: object({ input_tokens: dec, output_tokens: dec, cached_input_tokens: dec, generation_id: { type: 'string' }, provider_request_id: { type: 'string' }, observed_at: { type: 'string', format: 'date-time' } }, ['cached_input_tokens', 'provider_request_id']) }),
  AgentGrantRequest: object({ idempotency_key: { type: 'string' }, workspace_id: uuid, agent_npub: npub, service_npub: npub, model: { type: 'string' }, tariff_version: { type: 'string' }, daily_cap_units: dec, expires_at: { type: 'string', format: 'date-time' } }),
  AgentGrant: object({ id: uuid, account_id: uuid, workspace_id: uuid, agent_npub: npub, service_npub: npub, model: { type: 'string' }, tariff_version: { type: 'string' }, daily_cap_units: dec, expires_at: { type: 'string', format: 'date-time' }, revoked_at: { type: ['string', 'null'] }, created_at: { type: 'string', format: 'date-time' }, day_used_units: dec }, ['day_used_units']),
  AgentTariffRequest: object({ version: { type: 'string' }, models: { type: 'array', items: object({ model: { type: 'string' }, input_pico_per_token: dec, output_pico_per_token: dec, cached_input_pico_per_token: dec, cached_input_semantics: { enum: ['subset', 'additional'] }, request_pico: dec, max_input_tokens: dec, max_output_tokens: dec }, ['cached_input_pico_per_token', 'cached_input_semantics', 'request_pico']) } }),
};
const post = (summary: string, req: string, res: string, codes = ['200']) => ({ post: { summary, tags: ['Agent holds'], requestBody: json(ref(req)), responses: { ...Object.fromEntries(codes.map(c => [c, ok(ref(res))])), ...errors } } });
export const agentHoldsPaths: Record<string, any> = {
  '/api/v4/agent-holds/holds/reserve': post('Reserve units before inference (allowlisted runtime service, strict NIP-98)', 'AgentHoldReserveRequest', 'AgentHold', ['200', '201']),
  '/api/v4/agent-holds/holds/dispatch': post('Persist dispatch BEFORE the upstream call', 'AgentHoldIdentity', 'AgentHold'),
  '/api/v4/agent-holds/holds/pending': post('Mark outcome uncertain; funds stay held', 'AgentHoldPendingRequest', 'AgentHold'),
  '/api/v4/agent-holds/holds/release': post('Release only a never-dispatched or allowlisted explicitly rejected call', 'AgentHoldReleaseRequest', 'AgentHold'),
  '/api/v4/agent-holds/holds/settle': post('Settle once from host-observed token usage at the frozen tariff', 'AgentHoldSettleRequest', 'AgentHold'),
  '/api/v4/agent-holds/holds': { get: { summary: 'Read one hold (the calling service only)', tags: ['Agent holds'], parameters: ['account_id', 'call_id', 'hold_id'].map(name => ({ name, in: 'query', schema: { type: 'string' } })), responses: { '200': ok(ref('AgentHold')), ...errors } } },
  '/api/v4/agent-holds/grants': { ...post('Payer grants a runtime service spend authority (direct owner signature)', 'AgentGrantRequest', 'AgentGrant', ['200', '201']), get: { summary: 'List the payer grants with UTC day usage', tags: ['Agent holds'], responses: { '200': ok({ type: 'object', properties: { grants: { type: 'array', items: ref('AgentGrant') } } }), ...errors } } },
  '/api/v4/agent-holds/grants/{grantId}/revoke': { post: { summary: 'Revoke a grant; open holds still settle', tags: ['Agent holds'], parameters: [{ name: 'grantId', in: 'path', required: true, schema: uuid }], responses: { '200': ok({ type: 'object' }), ...errors } } },
  '/api/v4/agent-holds/tariffs': { ...post('Append an immutable tariff version (platform admin)', 'AgentTariffRequest', 'AgentTariffRequest', ['200', '201']), get: { summary: 'List frozen tariffs', tags: ['Agent holds'], responses: { '200': ok({ type: 'object' }), ...errors } } },
  '/api/v4/agent-holds/blocks/{accountId}/clear': { post: { summary: 'Clear an overrun spend block (platform admin)', tags: ['Agent holds'], parameters: [{ name: 'accountId', in: 'path', required: true, schema: uuid }], responses: { '200': ok({ type: 'object' }), ...errors } } },
};
