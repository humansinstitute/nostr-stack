// Shared binding check for broker output; the verifier must check ID and Schnorr signature.
export function validateSignedResponse(event: any, expected: any, verify: (e: any)=>boolean, sessionId?: string) {
  let tags = event?.tags;
  // Broker HTTP proofs include a fresh signed nonce and session custody binding.
  if (expected.kind === 27235 && sessionId && Array.isArray(tags)) {
    const nonce = tags.find((t: string[]) => t[0] === 'nonce');
    const custody = tags.find((t: string[]) => t[0] === 'wm-session-capability');
    if (nonce && (nonce.length !== 2 || !/^[0-9a-f]{32}$/.test(nonce[1]))) throw new Error('Invalid broker nonce');
    if (custody?.length === 4 && custody[2] === sessionId
      && /^[0-9a-f-]{36}$/.test(custody[1]) && /^[0-9a-f]{64}$/.test(custody[3])) {
      tags = tags.filter((t: string[]) => t !== custody && t !== nonce);
    }
  }
  if (!event || event.pubkey !== expected.pubkey || event.kind !== expected.kind
    || event.content !== expected.content || JSON.stringify(tags) !== JSON.stringify(expected.tags)
    || !Number.isInteger(event.created_at) || event.created_at < expected.created_at
    || event.created_at > expected.created_at + 5 || !verify(event)) {
    throw new Error('Invalid broker signature, candidate binding, or timestamp');
  }
}

export function safeBrokerError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^(Capability does not allow this operation|Nostr event (kind is not allowed|tag is not allowed|tags exceed policy|violates an exact tag constraint)|NIP-98 (origin|path|method) is not allowed|Invalid broker signature, candidate binding, or timestamp|Unexpected actor|Unexpected event actor|HTTP candidate outside synthetic root GET|Kind outside synthetic grant|Encryption outside synthetic self discovery list|Unsupported bridge operation)$/.test(message)
    ? message : 'Broker request failed (details redacted)';
}
