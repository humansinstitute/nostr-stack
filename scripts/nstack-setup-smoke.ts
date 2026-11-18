// Execute inside the disposable setup container; never run against shared data.
import {finalizeEvent,generateSecretKey,getPublicKey,nip19,verifyEvent} from 'nostr-tools';
import {createHash,randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
const origin='http://127.0.0.1:3100';
const directory=process.env.NSTACK_SETUP_DIRECTORY;
if(directory!=='/run/nstack'||process.env.DB_NAME!=='nstack')throw Error('Disposable setup environment required');
const resume=process.argv.includes('--resume');
const statePath='/run/nstack/disposable-smoke.json';
const key=resume?new Uint8Array(JSON.parse(await readFile(statePath,'utf8')).key):generateSecretKey();
const npub=nip19.npubEncode(getPublicKey(key));
async function request(path:string,method='GET',body?:unknown,signer=key){
 const raw=body===undefined?undefined:JSON.stringify(body);const url=origin+path;
 const tags=[['u',url],['method',method]];if(raw!==undefined)tags.push(['payload',createHash('sha256').update(raw).digest('hex')]);
 const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags,content:''},signer);
 return fetch(url,{method,headers:{'content-type':'application/json',authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64')},body:raw});
}
function check(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
const before=await (await fetch(origin+'/health')).json();
if(!resume){
 const bootstrap=JSON.parse(await readFile('/run/nstack/bootstrap.json','utf8'));
 const bad=await request('/api/v4/installation/claim','POST',{code:'0'.repeat(48)});check(bad.status===409,'bad code accepted');
 const anonymous=await fetch(origin+'/api/v4/installation/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:bootstrap.claim_code})});check(anonymous.status===401,'unsigned claim accepted');
 const claims=await Promise.all(Array.from({length:6},()=>request('/api/v4/installation/claim','POST',{code:bootstrap.claim_code})));
 check(claims.filter(r=>r.status===201).length===1,'claim race did not select exactly one');
 check(claims.filter(r=>r.status===409).length===5,'losing claims not denied');
 check((await request('/api/v4/installation/claim','POST',{code:bootstrap.claim_code})).status===409,'claim replay accepted');
 const created=await request('/api/v4/admin/flightdeck-pg/workspaces','POST',{workspace_name:'Disposable progressive setup',creator_npub:npub});
 const result=await created.json();check(created.ok,'workspace creation failed: '+JSON.stringify(result));
 check(Boolean(result.workspace_id),'workspace UUID absent');
 await writeFile(statePath,JSON.stringify({key:[...key],workspace_id:result.workspace_id,service_npub:before.service_npub}),{mode:0o600});
 console.log(JSON.stringify({fresh_boot:true,unsigned_denied:true,bad_code_denied:true,claim_race:true,replay_denied:true,workspace_created:true,service_npub:before.service_npub}));
}else{
 const saved=JSON.parse(await readFile(statePath,'utf8'));
 check(before.service_npub===saved.service_npub,'service identity changed');
 if(saved.storage_object_id){
  const persisted=await request('/api/v4/storage/'+saved.storage_object_id+'/content');
  check(persisted.ok&&await persisted.text()===saved.storage_content,'stored bytes after restart/recreation changed');
  console.log(JSON.stringify({stored_bytes_preserved:true}));
 }
 const nonce=randomBytes(32).toString('hex');const path=`/api/v4/flightdeck-pg/workspaces/${saved.workspace_id}/connection-proof?nonce=${nonce}`;
 const r=await request(path);const result=await r.json();check(r.ok,'workspace after recreate unavailable: '+JSON.stringify(result));
 check(verifyEvent(result.proof),'invalid backend proof');const proof=JSON.parse(result.proof.content);
 check(proof.nonce===nonce&&proof.workspace_id===saved.workspace_id&&proof.service_npub===saved.service_npub&&proof.request_url===origin+path,'proof binding mismatch');
 check((await request(path,'GET',undefined,generateSecretKey())).status===403,'unauthorized workspace readable');
 const prepared=await request('/api/v4/flightdeck-pg/workspaces/'+saved.workspace_id+'/storage/prepare','POST',{owner_npub:npub,content_type:'text/plain',file_name:'private-smoke.txt',size_bytes:13,is_public:false});
 const metadata=await prepared.json();check(prepared.ok,'storage prepare failed: '+JSON.stringify(metadata));
 check(metadata.upload_url===origin+'/api/v4/storage/'+metadata.object_id,'private S3 endpoint escaped in upload URL');
 const content='private-smoke';
 check((await request('/api/v4/storage/'+metadata.object_id,'PUT',{base64_data:Buffer.from(content).toString('base64')})).ok,'same-origin upload failed');
 const completed=await request('/api/v4/storage/'+metadata.object_id+'/complete','POST',{size_bytes:content.length,sha256_hex:createHash('sha256').update(content).digest('hex')});check(completed.ok,'complete failed');
 const download=await request('/api/v4/storage/'+metadata.object_id+'/content');
 check(download.ok&&await download.text()===content,'private download bytes mismatch');
 check((await fetch(origin+'/api/v4/storage/'+metadata.object_id+'/content')).status===401,'private anonymous read accepted');
 await writeFile(statePath,JSON.stringify({...saved,storage_object_id:metadata.object_id,storage_content:content}),{mode:0o600});
 console.log(JSON.stringify({private_upload_download:true,internal_storage_private:true}));
 console.log(JSON.stringify({recreation_identity_preserved:true,workspace_preserved:true,ownership_preserved:true,nonce_bound_proof:true,unauthorized_denied:true}));
}

// Even a different valid Nostr signer holding an old copied code cannot reopen
// administration. Verify against the durable claim, including on resumed runs.
const claimedBefore=await readFile('/run/nstack/claim.json','utf8');
const bootstrap=JSON.parse(await readFile('/run/nstack/bootstrap.json','utf8'));
check((await request('/api/v4/installation/claim','POST',{code:bootstrap.claim_code},generateSecretKey())).status===409,'old copied code granted administration to a new signer');
check(await readFile('/run/nstack/claim.json','utf8')===claimedBefore,'old code changed durable administrator');
console.log(JSON.stringify({old_code_new_signer_denied:true,durable_claim_unchanged:true}));
