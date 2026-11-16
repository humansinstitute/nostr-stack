import {request as httpRequest} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {verifyEvent,nip19} from 'nostr-tools';
import {inspectHostFips} from '../src/installation/host-fips';
const project=process.argv[2];if(!project||!/^[a-z0-9][a-z0-9_-]*$/.test(project))throw Error('Disposable project required');
const host=await inspectHostFips();if(host.state!=='ready')throw Error('Ready host daemon required');
const origin=`http://${host.peer_npub}.fips:43110`;
async function fixture(input:unknown){
 const p=Bun.spawn(['docker','compose','-p',project,'-f','docker-compose.setup.yml','exec','-T','tower','sh','-ec','set -a; . /run/nstack/runtime.env; bun scripts/nstack-fixture-sign.ts'],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
 p.stdin.write(JSON.stringify(input));p.stdin.end();const [code,out]=await Promise.all([p.exited,new Response(p.stdout).text()]);if(code!==0)throw Error('Disposable fixture signer unavailable');return JSON.parse(out);
}
async function api(path:string,method='GET',body?:unknown,unsigned=false){
 const raw=body===undefined?undefined:JSON.stringify(body);const url=origin+path;
 const auth=unsigned?{}:await fixture({url,method,body:raw});
 return await new Promise<{status:number;body:string}>(async(resolve,reject)=>{
  const req=httpRequest({host:host.mesh_address,port:43110,path,method,headers:{host:new URL(origin).host,'content-type':'application/json',...(raw?{'content-length':String(Buffer.byteLength(raw))}:{}),...auth},timeout:10000},res=>{let body='';res.setEncoding('utf8');res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode!,body}));});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('FIPS request timeout')));req.end(raw);
 });
}
function check(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
const metadata=await fixture({kind:'metadata'});const workspace=metadata.workspace_id;
const nonce=randomBytes(32).toString('hex');const proofPath=`/api/v4/flightdeck-pg/workspaces/${workspace}/connection-proof?nonce=${nonce}`;
const proofReply=await api(proofPath);check(proofReply.status===200,'FIPS proof denied');const proof=JSON.parse(proofReply.body).proof;
check(verifyEvent(proof)&&nip19.npubEncode(proof.pubkey)===metadata.service_npub,'FIPS backend identity mismatch');
check(JSON.parse(proof.content).request_url===origin+proofPath&&JSON.parse(proof.content).nonce===nonce,'FIPS proof URL/nonce mismatch');
const envelopeReply=await api(`/api/v4/flightdeck-pg/workspaces/${workspace}/connection-envelope`);check(envelopeReply.status===200,'FIPS QR denied');
const {parseWorkspaceConnection}=await import('../src/services/workspace-connection');const envelope=parseWorkspaceConnection(JSON.parse(envelopeReply.body).envelope);
check(!envelope.payload.transports.https&&envelope.payload.transports.fips?.peer_npub===host.peer_npub,'QR depends on HTTPS');
const prepared=await api(`/api/v4/flightdeck-pg/workspaces/${workspace}/storage/prepare`,'POST',{content_type:'text/plain',file_name:'fips-private.txt',is_public:false,size_bytes:12});
check(prepared.status===201,'FIPS prepare failed');const file=JSON.parse(prepared.body);check(file.upload_url.startsWith(origin+'/'),'FIPS upload escaped transport');
const content='private-fips';check((await api('/api/v4/storage/'+file.object_id,'PUT',{base64_data:Buffer.from(content).toString('base64')})).status===200,'FIPS upload failed');
check((await api('/api/v4/storage/'+file.object_id+'/complete','POST',{size_bytes:content.length,sha256_hex:createHash('sha256').update(content).digest('hex')})).status===200,'FIPS complete failed');
const download=await api('/api/v4/storage/'+file.object_id+'/content');check(download.status===200&&download.body===content,'FIPS bytes mismatch');
check((await api('/api/v4/storage/'+file.object_id+'/content','GET',undefined,true)).status===401,'FIPS anonymous private read allowed');
// Real byte-stream check over the same fixed mesh ingress.
const streamPath=`/api/v4/flightdeck-pg/workspaces/${workspace}/events/stream`;
const streamAuth=await fixture({url:origin+streamPath,method:'GET'});
await new Promise<void>((resolve,reject)=>{
 const req=httpRequest({host:host.mesh_address,port:43110,path:streamPath,headers:{host:new URL(origin).host,...streamAuth},timeout:10000},res=>{
  if(res.statusCode!==200||!res.headers['content-type']?.includes('text/event-stream')){res.resume();reject(Error('FIPS SSE denied'));return;}
  res.once('data',()=>{resolve();req.destroy();});
 });req.on('error',reject);req.on('timeout',()=>req.destroy(Error('FIPS SSE timeout')));req.end();
});
const relayOrigin=`ws://${host.peer_npub}.fips:43112`;
await new Promise<void>((resolve,reject)=>{
 const socket=new WebSocket(`ws://[${host.mesh_address}]:43112/`,{headers:{host:new URL(relayOrigin).host}});
 const timeout=setTimeout(()=>{socket.close();reject(Error('FIPS relay timeout'));},10000);
 let eventId='',authenticated=false,published=false,received=false;
 const finish=()=>{if(authenticated&&published&&received){clearTimeout(timeout);socket.close();resolve();}};
 socket.onerror=()=>{clearTimeout(timeout);reject(Error('FIPS relay socket failed'));};
 socket.onmessage=async(message)=>{try{
  const frame=JSON.parse(String(message.data));
  if(frame[0]==='AUTH'){
   const auth=await fixture({kind:'relay',url:relayOrigin,challenge:frame[1]});socket.send(JSON.stringify(['AUTH',auth]));
  }else if(frame[0]==='OK'&&frame[2]===true){
   if(frame[1]===eventId){published=true;socket.send(JSON.stringify(['REQ','smoke',{ids:[eventId]}]));}
   else {authenticated=true;const event=await fixture({kind:'relay-publish',url:relayOrigin,nonce:randomBytes(12).toString('hex')});eventId=event.id;socket.send(JSON.stringify(['EVENT',event]));}
  }else if(frame[0]==='EVENT'&&frame[1]==='smoke'&&frame[2]?.id===eventId){received=true;finish();}
 }catch(error){clearTimeout(timeout);socket.close();reject(error);}};
});
console.log(JSON.stringify({same_host_mesh_ingress:true,https_absent:true,signed_identity_proof:true,fips_only_qr:true,private_upload_download:true,anonymous_denied:true,sse:true,relay_authenticated_publish_query:true,remote_device:'not_tested'}));
