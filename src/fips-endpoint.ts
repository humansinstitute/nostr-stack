import {nip19} from 'nostr-tools';
/** Public endpoint metadata only; callers must still use a pinned native capability. */
export function canonicalFipsOrigin(value:string,websocket=false){
 try{
  const url=new URL(value);const prefix=url.hostname.endsWith('.fips')?url.hostname.slice(0,-5):'';
  const peer=nip19.decode(prefix);
  if(peer.type!=='npub'||nip19.npubEncode(peer.data)!==prefix||url.origin!==value||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!url.port||![websocket?'ws:':'http:'].includes(url.protocol))return null;
  return {origin:url.origin,peer_npub:prefix,port:Number(url.port)};
 }catch{return null;}
}
