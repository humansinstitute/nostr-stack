import { nip19, verifyEvent } from 'nostr-tools';
import { getEffectiveRequestUrl } from '../auth';
import { digest, requireCondition, StorageDelegationError } from './contract';

// Deliberately use the raw per-install signer. A workspace-key/user alias must
// never turn a delegated app request into a human-owner request.
export function storageControlProof(request: Request, rawBody: string) {
  try {
    const authorization = request.headers.get('authorization');
    requireCondition(authorization && authorization.startsWith('Nostr ') && Buffer.byteLength(authorization) <= 4096, 'storage_auth_required', 401);
    const event = JSON.parse(Buffer.from(authorization.slice(6), 'base64').toString('utf8'));
    requireCondition(verifyEvent(event) && event.kind === 27235 && event.content === '' && Number.isSafeInteger(event.created_at)
      && Math.abs(Math.floor(Date.now() / 1000) - event.created_at) <= 60, 'storage_auth_invalid', 401);
    for (const [name, expected] of [['u', getEffectiveRequestUrl(request).toString()], ['method', 'POST'], ['payload', digest(rawBody)]]) {
      const tags = event.tags.filter((tag: string[]) => tag[0] === name);
      requireCondition(tags.length === 1 && tags[0].length === 2 && tags[0][1] === expected, 'storage_auth_invalid', 401);
    }
    return { signer: nip19.npubEncode(event.pubkey), receipt: { body: rawBody, accepted_at: new Date().toISOString(), event: {
      id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind,
      tags: event.tags, content: event.content, sig: event.sig,
    } } };
  } catch { throw new StorageDelegationError('storage_auth_invalid', 401); }
}
