import {parseWorkspaceConnection,type WorkspaceConnectionV3} from '../services/workspace-connection';
import {verifyEvent,nip19,type Event} from 'nostr-tools';
export function parse(input:string){return parseWorkspaceConnection(input).payload;}
export function verifyProof(expected:WorkspaceConnectionV3,proof:Event,nonce:string,url:string,now=Math.floor(Date.now()/1000)){
 if(!verifyEvent(proof)||proof.kind!==30384||nip19.npubEncode(proof.pubkey)!==expected.service_npub||JSON.stringify(proof.tags)!==JSON.stringify([['d','nstack-connection-challenge-v1']])||proof.created_at<now-60||proof.created_at>now+5)throw Error('Backend identity proof invalid');
 const value=JSON.parse(proof.content);
 if(JSON.stringify(value)!==proof.content||Object.keys(value).sort().join(',')!==['nonce','service_npub','workspace_id','workspace_service_npub','request_url','expires_at'].sort().join(',')||value.nonce!==nonce||value.service_npub!==expected.service_npub||value.workspace_id!==expected.workspace_id||value.workspace_service_npub!==expected.workspace_service_npub||value.request_url!==url||!Number.isInteger(value.expires_at)||value.expires_at<=now||value.expires_at>now+60)throw Error('Backend or exact workspace identity mismatch');
}
