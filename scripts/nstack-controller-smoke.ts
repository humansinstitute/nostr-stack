// Run only inside the disposable setup stack created by nstack-setup-smoke.ts.
import {defaultModuleSettings} from '../src/installation/modules';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';import {finalizeEvent,getPublicKey,nip19} from 'nostr-tools';
if(process.env.DB_NAME!=='nstack')throw Error('Disposable installation only');
const saved=JSON.parse(await readFile('/run/nstack/disposable-smoke.json','utf8'));const key=new Uint8Array(saved.key);
const origin='http://127.0.0.1:3100';
async function request(path:string,method='GET',body?:unknown,authorization?:string){
 const raw=body===undefined?undefined:JSON.stringify(body),url=origin+path;
 const tags=[['u',url],['method',method]];if(raw!==undefined)tags.push(['payload',createHash('sha256').update(raw).digest('hex')]);
 const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags,content:''},key);
 const auth=authorization||'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64');
 const r=await fetch(url,{method,headers:{authorization:auth,'content-type':'application/json'},body:raw});
 return {status:r.status,body:await r.json(),authorization:auth};
}
const mode=process.argv[2];
if(mode==='status'){
 const result=await request('/api/v4/installation/settings');console.log(JSON.stringify({status:result.status,...result.body}));
}else if(mode==='replay'){
 const prior=JSON.parse(await readFile('/run/nstack/disposable-apply.json','utf8'));
 const result=await request('/api/v4/installation/settings/apply','POST',prior.desired,prior.authorization);
 if(result.status!==202||!result.body.replayed)throw Error('mutation replay was not idempotent');
 console.log(JSON.stringify({replay_deduplicated:true,operation_id:result.body.operation.id,state:result.body.operation.state}));
}else{
 const current=await request('/api/v4/installation/settings');if(current.status!==200)throw Error('settings denied');
 const desired={...current.body.settings,fips_desired:false};
 if(mode==='configure-fips'){desired.fips_desired=true;desired.fips={peer_npub:process.env.NSTACK_TEST_FIPS_NPUB,mesh_address:process.env.NSTACK_TEST_FIPS_ADDRESS,port:43110};}
 if(mode==='graph-only')desired.modules={...defaultModuleSettings(),graph:{enabled:true}};
 if(mode==='modules'){
  desired.fips_desired=true;
  if(!desired.fips)throw Error('Configure FIPS first');const peer=desired.fips.peer_npub,pubkey=getPublicKey(key),npub=nip19.npubEncode(pubkey);
  desired.modules={graph:{enabled:true},relay:{enabled:true,origin:`ws://${peer}.fips:43112`,publishers:[pubkey]},blossom:{enabled:true,origin:`http://${peer}.fips:43113`,publisher:pubkey},git:{enabled:true,origin:`http://${peer}.fips:43114`,members:[pubkey],maintainers:[pubkey],repository_readers:{[npub+'/smoke']:[pubkey]}}};
 }
 if(mode==='bad-https')desired.https_origin='https://127.0.0.1:1';
 if(mode==='invalid'){
  const result=await request('/api/v4/installation/settings/apply','POST',{...desired,command:'not-allowed'});
  if(result.status!==400)throw Error('unknown settings accepted');console.log(JSON.stringify({invalid_settings_denied:true}));
 }else{
  const result=await request('/api/v4/installation/settings/apply','POST',desired);
  if(result.status!==202)throw Error('apply denied: '+JSON.stringify(result.body));
  await writeFile('/run/nstack/disposable-apply.json',JSON.stringify({desired,authorization:result.authorization}),{mode:0o600});
  console.log(JSON.stringify({queued:true,operation_id:result.body.operation.id}));
 }
}
