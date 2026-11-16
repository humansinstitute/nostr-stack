import { finalizeEvent, nip19, verifyEvent, type Event } from 'nostr-tools';

export const WORKSPACE_CONNECTION_PREFIX = 'nstack:workspace:v3:';
export const WORKSPACE_CONNECTION_MAX_BYTES = 8192;
export const WORKSPACE_QR_MAX_BYTES = 2200;
export interface WorkspaceConnectionV3 {
  type: 'nstack-workspace'; version: 3; service_npub: string;
  workspace_id: string; workspace_service_npub: string; name?: string;
  transports: { https?: { url: string }; fips?: { peer_npub: string; host: string; port: number } };
  policy: { preferred: 'https' | 'fips'; fallback: 'none' };
}
function keys(value: unknown, allowed: string[], required = allowed): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k=>!(k in value))) throw Error('invalid_connection_shape');
}
function npub(value: unknown) {
  if (typeof value !== 'string') throw Error('invalid_npub');
  const decoded = nip19.decode(value);
  if (decoded.type !== 'npub' || nip19.npubEncode(decoded.data) !== value) throw Error('invalid_npub');
  return value;
}
export function validateWorkspaceConnection(value: unknown): WorkspaceConnectionV3 {
  keys(value,['type','version','service_npub','workspace_id','workspace_service_npub','name','transports','policy'],['type','version','service_npub','workspace_id','workspace_service_npub','transports','policy']);
  if(value.type!=='nstack-workspace'||value.version!==3)throw Error('unsupported_connection_version');
  npub(value.service_npub);npub(value.workspace_service_npub);
  if(typeof value.workspace_id!=='string'|| !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.workspace_id))throw Error('invalid_workspace_uuid');
  if(value.name!==undefined&&(typeof value.name!=='string'||value.name.length>128))throw Error('invalid_name');
  keys(value.transports,['https','fips'],[]);
  if(!value.transports.https&&!value.transports.fips)throw Error('transport_required');
  if(value.transports.https){
    keys(value.transports.https,['url']);const url=new URL(value.transports.https.url);
    if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.origin!==value.transports.https.url)throw Error('invalid_https_origin');
  }
  if(value.transports.fips){
    const f=value.transports.fips;keys(f,['peer_npub','host','port']);npub(f.peer_npub);
    if(f.host!==`${f.peer_npub}.fips`||!Number.isInteger(f.port)||f.port<1||f.port>65535)throw Error('invalid_fips_binding');
  }
  keys(value.policy,['preferred','fallback']);
  if(!['https','fips'].includes(value.policy.preferred)||!value.transports[value.policy.preferred]||value.policy.fallback!=='none')throw Error('invalid_transport_policy');
  return value as WorkspaceConnectionV3;
}
function secretBytes(secret: string) {
  const decoded=nip19.decode(secret);if(decoded.type!=='nsec')throw Error('service_identity_unavailable');return decoded.data;
}
export function signWorkspaceConnection(payload: WorkspaceConnectionV3, secret: string): string {
  validateWorkspaceConnection(payload);
  const event=finalizeEvent({kind:30383,created_at:Math.floor(Date.now()/1000),tags:[['d','nstack-workspace-connection-v3']],content:JSON.stringify(payload)},secretBytes(secret));
  if(nip19.npubEncode(event.pubkey)!==payload.service_npub)throw Error('service_identity_mismatch');
  const bytes=new TextEncoder().encode(JSON.stringify(event));
  if(bytes.length>WORKSPACE_CONNECTION_MAX_BYTES)throw Error('connection_too_large');
  const envelope=WORKSPACE_CONNECTION_PREFIX+btoa(Array.from(bytes,b=>String.fromCharCode(b)).join('')).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
  if(new TextEncoder().encode(envelope).length>WORKSPACE_CONNECTION_MAX_BYTES)throw Error('connection_too_large');
  return envelope;
}
function canonicalJson(raw: string) {
  const value=JSON.parse(raw);if(JSON.stringify(value)!==raw)throw Error('noncanonical_or_duplicate_json');return value;
}
export function parseWorkspaceConnection(envelope: string): {event:Event;payload:WorkspaceConnectionV3} {
  if(typeof envelope!=='string'||new TextEncoder().encode(envelope).length>WORKSPACE_CONNECTION_MAX_BYTES||!envelope.startsWith(WORKSPACE_CONNECTION_PREFIX))throw Error('unsupported_connection_envelope');
  const encoded=envelope.slice(WORKSPACE_CONNECTION_PREFIX.length);
  if(!/^[A-Za-z0-9_-]+$/.test(encoded))throw Error('invalid_encoding');
  const base64=encoded.replaceAll('-','+').replaceAll('_','/');const binary=atob(base64+'='.repeat((4-base64.length%4)%4));
  const raw=Uint8Array.from(binary,c=>c.charCodeAt(0));if(btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')!==encoded)throw Error('invalid_encoding');
  const event=canonicalJson(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  keys(event,['kind','created_at','tags','content','pubkey','id','sig']);
  if(!verifyEvent(event as Event)||event.kind!==30383||event.created_at>Math.floor(Date.now()/1000)+300||JSON.stringify(event.tags)!==JSON.stringify([['d','nstack-workspace-connection-v3']]))throw Error('invalid_connection_proof');
  const payload=validateWorkspaceConnection(canonicalJson(event.content));
  if(nip19.npubEncode(event.pubkey)!==payload.service_npub)throw Error('service_identity_mismatch');
  return {event:event as Event,payload};
}
export function signConnectionChallenge(payload: Record<string, unknown>, secret: string) {
  return finalizeEvent({kind:30384,created_at:Math.floor(Date.now()/1000),tags:[['d','nstack-connection-challenge-v1']],content:JSON.stringify(payload)},secretBytes(secret));
}
