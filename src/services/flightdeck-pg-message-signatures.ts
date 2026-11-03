import { createHash } from 'crypto';
import { nip19, verifyEvent, type Event } from 'nostr-tools';

export const AGENT_INSTRUCTION_SIGNATURE_METADATA_KEY = 'agent_instruction_signature';
/** Server-owned message metadata: the validated origin notification named for a deliberate self-address. */
export const AGENT_ORIGIN_METADATA_KEY = 'agent_origin_notification_id';
export const AGENT_INSTRUCTION_SIGNATURE_PROTOCOL = 'flightdeck_pg_message_instruction';
export const AGENT_INSTRUCTION_SIGNATURE_KIND = 33358;

export type FlightDeckPgMessageSignatureValidationError = {
  path: string;
  code: string;
  message: string;
};

/**
 * Canonical hash of a message's structured mentions for the optional `mentions_sha256` tag: lowercase hex SHA-256 of
 * the UTF-8 bytes of JSON.stringify([{type, npub}, ...]) with lowercase values, deduped, sorted by npub then type.
 * An empty list hashes "[]".
 */
export function canonicalMentionsSha256(mentions: unknown): string {
  const list = Array.isArray(mentions) ? mentions : [];
  const seen = new Map<string, { type: string; npub: string }>();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const type = String((entry as Record<string, unknown>).type ?? '').toLowerCase();
    const npub = String((entry as Record<string, unknown>).npub ?? '').toLowerCase();
    if (!type || !npub) continue;
    seen.set(`${npub}\u0000${type}`, { type, npub });
  }
  const sorted = [...seen.values()].sort((a, b) => (a.npub < b.npub ? -1 : a.npub > b.npub ? 1 : a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return sha256Hex(JSON.stringify(sorted.map(({ type, npub }) => ({ type, npub }))));
}

export type FlightDeckPgMessageInstructionSignature = {
  version: 1;
  protocol: typeof AGENT_INSTRUCTION_SIGNATURE_PROTOCOL;
  kind: typeof AGENT_INSTRUCTION_SIGNATURE_KIND;
  signer_npub: string;
  body_sha256: string;
  nostr_event: Event;
  message_id?: string;
  revision?: number;
  mentions_sha256?: string;
};

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function eventTagValue(event: Event, name: string): string | null {
  const tag = event.tags.find((entry) => entry[0] === name);
  return typeof tag?.[1] === 'string' && tag[1].trim() ? tag[1].trim() : null;
}

function isEventLike(value: unknown): value is Event {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<Event>;
  return typeof candidate.id === 'string'
    && typeof candidate.pubkey === 'string'
    && typeof candidate.created_at === 'number'
    && typeof candidate.kind === 'number'
    && Array.isArray(candidate.tags)
    && typeof candidate.content === 'string'
    && typeof candidate.sig === 'string';
}

export function validateFlightDeckPgMessageInstructionSignature(input: {
  value: unknown;
  body: string;
  actorNpub: string;
  workspaceId: string;
  channelId: string;
  threadId?: string | null;
  messageId?: string;
  revision?: number;
  /** The canonical mentions being saved. When the event carries `mentions_sha256` it must match them. */
  mentions?: unknown;
}): { signature: FlightDeckPgMessageInstructionSignature | null; errors: FlightDeckPgMessageSignatureValidationError[] } {
  const errors: FlightDeckPgMessageSignatureValidationError[] = [];
  const wrapper = input.value && typeof input.value === 'object' && !Array.isArray(input.value)
    ? input.value as Record<string, unknown>
    : null;
  if (!wrapper) {
    return {
      signature: null,
      errors: [{ path: 'message_signature', code: 'required', message: 'message_signature is required for PG chat messages' }],
    };
  }

  const event = isEventLike(wrapper.nostr_event) ? wrapper.nostr_event : null;
  if (!event) {
    errors.push({ path: 'message_signature.nostr_event', code: 'invalid', message: 'nostr_event must be a signed Nostr event' });
  }
  if (wrapper.version !== 1) {
    errors.push({ path: 'message_signature.version', code: 'invalid', message: 'message_signature version must be 1' });
  }

  if (!event) {
    return { signature: null, errors };
  }

  const bodySha256 = sha256Hex(input.body);
  const signerNpub = nip19.npubEncode(event.pubkey);
  const protocolTag = eventTagValue(event, 'protocol');
  const bodyHashTag = eventTagValue(event, 'body_sha256');
  const workspaceTag = eventTagValue(event, 'workspace_id');
  const channelTag = eventTagValue(event, 'channel_id');
  const threadTag = eventTagValue(event, 'thread_id');
  const messageTag = eventTagValue(event, 'message_id');
  const revisionTag = eventTagValue(event, 'revision');
  const mentionsTag = eventTagValue(event, 'mentions_sha256');

  if (event.kind !== AGENT_INSTRUCTION_SIGNATURE_KIND) {
    errors.push({ path: 'message_signature.nostr_event.kind', code: 'invalid', message: `nostr_event kind must be ${AGENT_INSTRUCTION_SIGNATURE_KIND}` });
  }
  if (protocolTag !== AGENT_INSTRUCTION_SIGNATURE_PROTOCOL) {
    errors.push({ path: 'message_signature.nostr_event.tags.protocol', code: 'invalid', message: 'nostr_event protocol tag is invalid' });
  }
  if (!verifyEvent(event)) {
    errors.push({ path: 'message_signature.nostr_event.sig', code: 'invalid', message: 'nostr_event signature verification failed' });
  }
  if (event.content !== input.body) {
    errors.push({ path: 'message_signature.nostr_event.content', code: 'invalid', message: 'nostr_event content must exactly match body' });
  }
  if (bodyHashTag !== bodySha256 || wrapper.body_sha256 !== bodySha256) {
    errors.push({ path: 'message_signature.body_sha256', code: 'invalid', message: 'body_sha256 must match the message body' });
  }
  if (signerNpub !== input.actorNpub || wrapper.signer_npub !== input.actorNpub) {
    errors.push({ path: 'message_signature.signer_npub', code: 'invalid', message: 'message_signature signer must match the authenticated actor' });
  }
  if (workspaceTag !== input.workspaceId) {
    errors.push({ path: 'message_signature.nostr_event.tags.workspace_id', code: 'invalid', message: 'workspace_id tag must match the message workspace' });
  }
  if (channelTag !== input.channelId) {
    errors.push({ path: 'message_signature.nostr_event.tags.channel_id', code: 'invalid', message: 'channel_id tag must match the message channel' });
  }
  if (input.threadId && threadTag !== input.threadId) {
    errors.push({ path: 'message_signature.nostr_event.tags.thread_id', code: 'invalid', message: 'thread_id tag must match the target thread' });
  }
  if (input.messageId && messageTag !== input.messageId) {
    errors.push({ path: 'message_signature.nostr_event.tags.message_id', code: 'invalid', message: 'message_id tag must match the edited message' });
  }
  if (mentionsTag !== null && mentionsTag !== canonicalMentionsSha256(input.mentions)) {
    errors.push({ path: 'message_signature.nostr_event.tags.mentions_sha256', code: 'invalid', message: 'mentions_sha256 tag must match the canonical structured mentions' });
  }
  if (input.revision !== undefined && revisionTag !== String(input.revision)) {
    errors.push({ path: 'message_signature.nostr_event.tags.revision', code: 'invalid', message: 'revision tag must match the saved message revision' });
  }

  if (errors.length) return { signature: null, errors };
  return {
    signature: {
      version: 1,
      protocol: AGENT_INSTRUCTION_SIGNATURE_PROTOCOL,
      kind: AGENT_INSTRUCTION_SIGNATURE_KIND,
      signer_npub: signerNpub,
      body_sha256: bodySha256,
      nostr_event: event,
      ...(input.messageId ? { message_id: input.messageId } : {}),
      ...(input.revision !== undefined ? { revision: input.revision } : {}),
      ...(mentionsTag !== null ? { mentions_sha256: mentionsTag } : {}),
    },
    errors: [],
  };
}

/**
 * Re-verify a STORED instruction signature against the exact message revision being projected. Used only for
 * deliberate self-address: the signer must be the author and `mentions_sha256` must bind the projected mentions.
 */
export function storedSignatureBindsRevision(input: {
  signature: unknown;
  body: string;
  mentions: unknown;
  authorNpub: string;
  workspaceId: string;
  channelId: string;
  threadId: string | null;
  messageId: string;
  revision: number;
  revised: boolean;
}): boolean {
  const wrapper = input.signature && typeof input.signature === 'object' ? input.signature as Record<string, unknown> : null;
  const event = wrapper && isEventLike(wrapper.nostr_event) ? wrapper.nostr_event : null;
  if (!event || event.kind !== AGENT_INSTRUCTION_SIGNATURE_KIND || !verifyEvent(event)) return false;
  if (eventTagValue(event, 'protocol') !== AGENT_INSTRUCTION_SIGNATURE_PROTOCOL) return false;
  if (nip19.npubEncode(event.pubkey) !== input.authorNpub || event.content !== input.body) return false;
  if (eventTagValue(event, 'body_sha256') !== sha256Hex(input.body)) return false;
  if (eventTagValue(event, 'workspace_id') !== input.workspaceId || eventTagValue(event, 'channel_id') !== input.channelId) return false;
  if ((eventTagValue(event, 'thread_id') ?? null) !== input.threadId) return false;
  if (input.revised && (eventTagValue(event, 'message_id') !== input.messageId || eventTagValue(event, 'revision') !== String(input.revision))) return false;
  return eventTagValue(event, 'mentions_sha256') === canonicalMentionsSha256(input.mentions);
}
