import QRCode from 'qrcode';
import {test,expect} from 'bun:test';
import {generateSecretKey,getPublicKey,nip19,finalizeEvent} from 'nostr-tools';
import {signWorkspaceConnection,parseWorkspaceConnection,validateWorkspaceConnection,WORKSPACE_CONNECTION_PREFIX,type WorkspaceConnectionV3} from '../src/services/workspace-connection';
const sk=generateSecretKey();const npub=nip19.npubEncode(getPublicKey(sk));
const payload:WorkspaceConnectionV3={type:'nstack-workspace',version:3,service_npub:npub,workspace_id:'00000000-0000-4000-8000-000000000001',workspace_service_npub:npub,transports:{fips:{peer_npub:npub,host:npub+'.fips',port:3190}},policy:{preferred:'fips',fallback:'none'}};
test('FIPS-only envelope is signed, self contained and app independent',()=>{
 const envelope=signWorkspaceConnection(payload,nip19.nsecEncode(sk));
 expect(parseWorkspaceConnection(envelope).payload).toEqual(payload);
 expect(envelope.length).toBeLessThan(2200);
 expect(JSON.stringify(payload)).not.toContain('app_npub');
});
test('reject tampering, duplicate JSON, wrong identities and peer hosts',()=>{
 expect(()=>validateWorkspaceConnection({...payload,transports:{fips:{...payload.transports.fips,host:'other.fips'}}})).toThrow();
 expect(()=>validateWorkspaceConnection({...payload,app_npub:npub})).toThrow();
 expect(()=>validateWorkspaceConnection({...payload,policy:{preferred:'fips',fallback:'https'}})).toThrow();
 expect(()=>signWorkspaceConnection({...payload,service_npub:nip19.npubEncode(getPublicKey(generateSecretKey()))},nip19.nsecEncode(sk))).toThrow();
 const envelope=signWorkspaceConnection(payload,nip19.nsecEncode(sk));
 const raw=Buffer.from(envelope.slice(WORKSPACE_CONNECTION_PREFIX.length),'base64url').toString();
 expect(()=>parseWorkspaceConnection(WORKSPACE_CONNECTION_PREFIX+Buffer.from(raw.replace('30383','30382')).toString('base64url'))).toThrow();
 expect(()=>parseWorkspaceConnection(WORKSPACE_CONNECTION_PREFIX+Buffer.from(raw.replace('{','{"kind":30383,')).toString('base64url'))).toThrow();
 const duplicate=finalizeEvent({kind:30383,created_at:Math.floor(Date.now()/1000),tags:[['d','nstack-workspace-connection-v3']],content:JSON.stringify(payload).replace('{','{"version":3,')},sk);
 expect(()=>parseWorkspaceConnection(WORKSPACE_CONNECTION_PREFIX+Buffer.from(JSON.stringify(duplicate)).toString('base64url'))).toThrow();
});

test('both transport envelope fits an actual QR encoder at M correction',async()=>{
 const both={...payload,name:'Workspace',transports:{...payload.transports,https:{url:'https://nstack.example'}}};
 const envelope=signWorkspaceConnection(both,nip19.nsecEncode(sk));
 expect(envelope.length).toBeLessThanOrEqual(2200);
 expect(await QRCode.toString(envelope,{type:'svg',errorCorrectionLevel:'M'})).toContain('<svg');
});
