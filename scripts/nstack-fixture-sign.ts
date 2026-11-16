// Disposable integration signer. Never reads any operator/service key.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';import {finalizeEvent,getPublicKey,nip19} from 'nostr-tools';
import {readInstallationSettings} from '../src/installation/settings';
if(process.env.DB_NAME!=='nstack')throw Error('Disposable installation only');
const saved=JSON.parse(await readFile('/run/nstack/disposable-smoke.json','utf8'));const key=new Uint8Array(saved.key);
const input=JSON.parse(await Bun.stdin.text());const settings=readInstallationSettings();
if(input.kind==='metadata'){console.log(JSON.stringify({workspace_id:saved.workspace_id,service_npub:saved.service_npub,actor_npub:nip19.npubEncode(getPublicKey(key))}));process.exit(0);}
const url=new URL(input.url);if(!settings.fips||url.hostname!==settings.fips.peer_npub+'.fips')throw Error('Fixture endpoint mismatch');
if(input.kind==='relay-publish'){
 if(url.origin!==settings.modules?.relay.origin)throw Error('Fixture relay mismatch');
 console.log(JSON.stringify(finalizeEvent({kind:1,created_at:Math.floor(Date.now()/1000),tags:[],content:'Disposable progressive setup '+input.nonce},key)));
}else if(input.kind==='relay'){
 if(url.origin!==settings.modules?.relay.origin||input.challenge.length>512)throw Error('Fixture relay mismatch');
 console.log(JSON.stringify(finalizeEvent({kind:22242,created_at:Math.floor(Date.now()/1000),tags:[['relay',input.url],['challenge',input.challenge]],content:''},key)));
}else{
 if(url.port!==String(settings.fips.port)||!url.pathname.startsWith('/api/v4/'))throw Error('Fixture API mismatch');
 const tags=[['u',input.url],['method',input.method]];if(input.body!==undefined)tags.push(['payload',createHash('sha256').update(input.body).digest('hex')]);
 const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags,content:''},key);
 console.log(JSON.stringify({authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64')}));
}
