import { createHash } from 'crypto';

import { describe, expect, test } from 'bun:test';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

import {
  AGENT_INSTRUCTION_SIGNATURE_KIND,
  AGENT_INSTRUCTION_SIGNATURE_PROTOCOL,
  validateFlightDeckPgMessageInstructionSignature,
  canonicalMentionsSha256,
  storedSignatureBindsRevision,
} from '../src/services/flightdeck-pg-message-signatures';

function makeSignature(input: {
  body: string;
  actorNpub: string;
  secretKey: Uint8Array;
  workspaceId: string;
  channelId: string;
  threadId?: string;
}) {
  const bodySha256 = createHash('sha256').update(input.body, 'utf8').digest('hex');
  const tags = [
    ['protocol', AGENT_INSTRUCTION_SIGNATURE_PROTOCOL],
    ['body_sha256', bodySha256],
    ['workspace_id', input.workspaceId],
    ['channel_id', input.channelId],
  ];
  if (input.threadId) tags.push(['thread_id', input.threadId]);
  const event = finalizeEvent({
    kind: AGENT_INSTRUCTION_SIGNATURE_KIND,
    created_at: 1_781_000_000,
    tags,
    content: input.body,
  }, input.secretKey);
  return {
    version: 1,
    protocol: AGENT_INSTRUCTION_SIGNATURE_PROTOCOL,
    kind: AGENT_INSTRUCTION_SIGNATURE_KIND,
    signer_npub: input.actorNpub,
    body_sha256: bodySha256,
    nostr_event: event,
  };
}

describe('Flight Deck PG message instruction signatures', () => {
  test('accepts a signature over the exact message body from the authenticated actor', () => {
    const secretKey = generateSecretKey();
    const actorNpub = nip19.npubEncode(getPublicKey(secretKey));
    const signature = makeSignature({
      body: 'Run the workspace summary',
      actorNpub,
      secretKey,
      workspaceId: 'workspace-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
    });

    const result = validateFlightDeckPgMessageInstructionSignature({
      value: signature,
      body: 'Run the workspace summary',
      actorNpub,
      workspaceId: 'workspace-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
    });

    expect(result.errors).toEqual([]);
    expect(result.signature?.signer_npub).toBe(actorNpub);
  });

  test('rejects a missing signature', () => {
    const result = validateFlightDeckPgMessageInstructionSignature({
      value: null,
      body: 'Unsigned instruction',
      actorNpub: 'npub1actor',
      workspaceId: 'workspace-1',
      channelId: 'channel-1',
    });

    expect(result.signature).toBeNull();
    expect(result.errors[0]?.code).toBe('required');
  });

  test('rejects a signature when the persisted body was changed', () => {
    const secretKey = generateSecretKey();
    const actorNpub = nip19.npubEncode(getPublicKey(secretKey));
    const signature = makeSignature({
      body: 'Original instruction',
      actorNpub,
      secretKey,
      workspaceId: 'workspace-1',
      channelId: 'channel-1',
    });

    const result = validateFlightDeckPgMessageInstructionSignature({
      value: signature,
      body: 'Tampered instruction',
      actorNpub,
      workspaceId: 'workspace-1',
      channelId: 'channel-1',
    });

    expect(result.signature).toBeNull();
    expect(result.errors.map((error) => error.code)).toContain('invalid');
  });
});


describe('self-address location binding', () => {
  test('omitted thread is valid only for unthreaded messages or the server-created root revision', () => {
    const secretKey = generateSecretKey();
    const authorNpub = nip19.npubEncode(getPublicKey(secretKey));
    const mentions = [{ type: 'agent', npub: authorNpub }];
    const signature = makeSignature({ body: 'Start', actorNpub: authorNpub, secretKey, workspaceId: 'w', channelId: 'c' });
    signature.nostr_event = finalizeEvent({ kind: signature.nostr_event.kind, content: 'Start', created_at: 1781000000,
      tags: [...signature.nostr_event.tags, ['mentions_sha256', canonicalMentionsSha256(mentions)]] }, secretKey);
    const input = { signature, body: 'Start', mentions, authorNpub, workspaceId: 'w', channelId: 'c', threadId: 'allocated', messageId: 'root', revision: 1, revised: false };
    expect(storedSignatureBindsRevision(input)).toBe(false); // no arbitrary cross-thread replay
    expect(storedSignatureBindsRevision({ ...input, threadId: null })).toBe(true);
    expect(storedSignatureBindsRevision({ ...input, createdThread: true })).toBe(true);
    expect(storedSignatureBindsRevision({ ...input, createdThread: true, revision: 2 })).toBe(false);
    expect(storedSignatureBindsRevision({ ...input, createdThread: true, revised: true })).toBe(false);
    expect(storedSignatureBindsRevision({ ...input, createdThread: true, mentions: [] })).toBe(false);
    expect(storedSignatureBindsRevision({ ...input, createdThread: true, body: 'Tampered' })).toBe(false);
    expect(storedSignatureBindsRevision({ ...input, createdThread: true, channelId: 'other' })).toBe(false);
  });
});
