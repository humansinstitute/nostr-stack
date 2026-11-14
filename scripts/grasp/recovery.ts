/** Isolated Docker recovery gate: never mounts or restarts a live service volume. */
import {mkdirSync,existsSync,writeFileSync,chmodSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {GraspClient,nostr} from '../../lib/grasp/client';
import {Client,command} from '../../lib/grasp/transport';
const path=resolve(process.argv[2]),c=await Bun.file(path).json(),evidence=resolve(c.evidence);
if(!evidence.includes('/tmp/docs/handoffs/')||existsSync(evidence))throw Error('Use a new ignored evidence directory');
const ownerClient=new GraspClient(c.repositories[0].root);
await ownerClient.git(['check-ignore',evidence],process.cwd(),false);
if(await ownerClient.git(['ls-files','--',evidence],process.cwd(),false))throw Error('Evidence is tracked');
for(const value of [c.name,c.volume,c.restoreName,c.restoreVolume])if(!/^nstack-grasp-test-[a-z0-9-]+$/.test(value))throw Error('Only explicitly disposable test names are accepted');
if(c.name===c.restoreName||c.volume===c.restoreVolume)throw Error('Independent restore targets required');
if(!/^sha256:[a-f0-9]{64}$/.test(c.image))throw Error('Immutable tested image ID required');
for(const name of [c.name,c.restoreName]){const p=Bun.spawnSync(['docker','container','inspect',name],{stdout:'ignore',stderr:'ignore'});if(p.exitCode===0)throw Error('Test container already exists');}
for(const name of [c.volume,c.restoreVolume]){const p=Bun.spawnSync(['docker','volume','inspect',name],{stdout:'ignore',stderr:'ignore'});if(p.exitCode===0)throw Error('Test volume already exists');}
mkdirSync(evidence,{recursive:true,mode:0o700});chmodSync(evidence,0o700);
const excluded=nostr.generateSecretKey(),excludedNpub=nostr.nip19.npubEncode(nostr.getPublicKey(excluded));
const actor=ownerClient.coordinate.actor,host=new URL(ownerClient.root).host;
const manifest=Object.fromEntries(c.repositories.map((r:any)=>{const client=new GraspClient(r.root);if(client.coordinate.actor!==actor||new URL(r.root).host!==host)throw Error('Single owner/service test snapshot required');return [`${actor}/${client.coordinate.identifier}`,[actor]];}));
const manifestPath=join(evidence,'readers.json');writeFileSync(manifestPath,JSON.stringify(manifest,null,2),{mode:0o444});
const events=await Bun.file(c.events).json();if(!Array.isArray(events)||events.some(e=>!nostr.verifyEvent(e)))throw Error('Invalid signed source events');
events.sort((a,b)=>[30617,30618,1618].indexOf(a.kind)-[30617,30618,1618].indexOf(b.kind));
const result:any={started_at:new Date().toISOString(),image:c.image,repositories:[],liveServicesTouched:false};
const save=()=>writeFileSync(join(evidence,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});save();
async function start(name:string,volume:string){
 await command(['docker','run','-d','--name',name,'--network','none','-e','NGIT_DOMAIN='+host,'-e','NGIT_PRIVATE_PUBLIC_ORIGIN='+new URL(ownerClient.root).origin,'-e','NGIT_PRIVATE_MODE=true','-e',`NGIT_PRIVATE_MEMBERS=${actor},${excludedNpub}`,'-e','NGIT_PRIVATE_REPOSITORY_READERS_FILE=/config/readers.json','-e','NGIT_GRASP06_ENABLE=false','-e','NGIT_SYNC_PLUS_ENABLED=false','-e','NGIT_USER_INDEX_RELAYS=','-e','NGIT_SYNC_PLUS_FALLBACK_RELAYS=','-e','NGIT_DATABASE_BACKEND=lmdb','-e','NGIT_BIND_ADDRESS=0.0.0.0:7334','-v',volume+':/data','-v',manifestPath+':/config/readers.json:ro',c.image]);
 for(let n=0;n<30;n++){const r=Bun.spawnSync(['docker','exec',name,'curl','--fail','--silent','--header','Accept: application/nostr+json','http://127.0.0.1:7334/'],{stdout:'pipe',stderr:'ignore'});if(r.exitCode===0)return JSON.parse(r.stdout.toString());await new Promise(r=>setTimeout(r,200));}throw Error('Isolated service not ready');
}
async function readback(name:string){
 for(const r of c.repositories){const client=new GraspClient(r.root),inside=new Client(r.root,client.relay,name),credential=await client.credential();const member=await inside.http('/info/refs?service=git-upload-pack',credential);if(member.status!==200||!member.body.includes(r.main))throw Error('Restored member Git read mismatch');
 const fixture=nostr.finalizeEvent({kind:27235,content:'',created_at:Math.floor(Date.now()/1000),tags:[['u',r.root],['method','GET']]},excluded);const denied=await inside.http('/info/refs?service=git-upload-pack','Nostr '+Buffer.from(JSON.stringify(fixture)).toString('base64'));if(denied.status!==401||denied.body!=='')throw Error('Excluded service member Git leak');
 const gitPath='/data/git/'+actor+'/'+client.coordinate.identifier+'.git';
 const refs=await command(['docker','exec',name,'git','--git-dir='+gitPath,'for-each-ref','--format=%(objectname) %(refname)']);
 const objects=await command(['docker','exec',name,'git','--git-dir='+gitPath,'rev-list','--objects','--all']);await command(['docker','exec',name,'git','--git-dir='+gitPath,'fsck','--full']);
 const originalRefs=await client.git(['for-each-ref','--format=%(objectname) %(refname)'],r.source,false),originalObjects=await client.git(['rev-list','--objects','--all'],r.source,false);
 const ids=(v:string)=>v.trim().split('\n').map(l=>l.split(' ')[0]).sort().join('\n');if(refs.trim()!==originalRefs||ids(objects)!==ids(originalObjects))throw Error('Restored Git refs/objects differ');
 }
 const inside=new Client(ownerClient.root,ownerClient.relay,name);
 const actual=await inside.events(e=>ownerClient.sign(e),{ids:events.map(e=>e.id)});if(events.some(e=>!actual.some(x=>x.id===e.id)))throw Error('Restored signed events differ');
 const leaked=await inside.events(e=>nostr.finalizeEvent(e,excluded),{kinds:[30617,30618,1618]});if(leaked.length)throw Error('Excluded service member broad relay leak');
 return {gitRepositories:c.repositories.length,signedEvents:actual.length,memberRead:true,excludedMemberGitDenied:true,excludedMemberBroadRelayDenied:true,fsck:true,refsAndObjects:true};
}
try{
 await command(['docker','volume','create',c.volume]);
 for(const r of c.repositories){const identifier=new GraspClient(r.root).coordinate.identifier;await command(['docker','run','--rm','--network','none','--entrypoint','sh','-v',resolve(r.source)+':/input:ro','-v',c.volume+':/data',c.image,'-c','mkdir -p "/data/git/$1" && cp -a /input "/data/git/$1/$2.git" && chown -R 10001:10001 /data','sh',actor,identifier]);}
 const before=await start(c.name,c.volume);result.publicIdentity=before.pubkey;save();
 const inside=new Client(ownerClient.root,ownerClient.relay,c.name),{s,auth}=await inside.authenticate(e=>ownerClient.sign(e));if(auth[2]!==true)throw Error('Owner auth denied');
 try{for(const e of events){s.send(['EVENT',e]);const ack=await s.next();(result.publication??=[]).push({kind:e.kind,id:e.id,ack});save();if(ack[0]!=='OK'||ack[1]!==e.id||ack[2]!==true)throw Error('Snapshot signed event replay denied');}}finally{s.close();}
 result.before=await readback(c.name);save();
 await command(['docker','stop','--time','60',c.name]);
 const backup=join(evidence,'backup');mkdirSync(backup,{mode:0o700});copyFileSync(manifestPath,join(backup,'readers.json'));
 await command(['docker','run','--rm','--network','none','--entrypoint','tar','-v',c.volume+':/source:ro','-v',backup+':/backup',c.image,'-C','/source','-cpf','/backup/volume.tar','.']);
 const archive=join(backup,'volume.tar');chmodSync(archive,0o600);result.backupSha256=createHash('sha256').update(Buffer.from(await Bun.file(archive).arrayBuffer())).digest('hex');save();
 await command(['docker','volume','create',c.restoreVolume]);await command(['docker','run','--rm','--network','none','--entrypoint','tar','-v',c.restoreVolume+':/restore','-v',backup+':/backup:ro',c.image,'-C','/restore','-xpf','/backup/volume.tar']);
 const after=await start(c.restoreName,c.restoreVolume);if(after.pubkey!==before.pubkey)throw Error('Restored service identity differs');
 result.after=await readback(c.restoreName);result.identityPreserved=true;result.complete=true;result.finished_at=new Date().toISOString();save();console.log(JSON.stringify(result,null,2));
}catch(error){result.error=error instanceof Error?error.message:'Recovery gate failed';result.complete=false;save();throw error;}finally{for(const name of [c.name,c.restoreName])Bun.spawnSync(['docker','stop','--time','30',name],{stdout:'ignore',stderr:'ignore'});}
