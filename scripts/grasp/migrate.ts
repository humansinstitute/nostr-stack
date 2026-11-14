/** Explicit snapshot import. Never deletes source/destination refs or changes consumer remotes. */
import {existsSync,mkdirSync,writeFileSync,realpathSync,readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {GraspClient,nostr} from '../../lib/grasp/client';
const [mode,path,hash]=process.argv.slice(2);
if(!['plan','publish','resume','verify'].includes(mode))throw Error('Use plan|publish|resume|verify CONFIG SHA256');
const config=resolve(path),raw=await Bun.file(config).text();
if(createHash('sha256').update(raw).digest('hex')!==hash)throw Error('Config hash mismatch');
const c=JSON.parse(raw),client=new GraspClient(c.destination),directory=dirname(config),source=realpathSync(c.source);
if(!directory.includes('/tmp/docs/handoffs/'))throw Error('Use ignored operational handoff directory');
await client.git(['check-ignore',config],process.cwd(),false);
if(await client.git(['ls-files','--',config],process.cwd(),false))throw Error('Config is tracked');
const allRefs=(await client.git(['for-each-ref','--format=%(objectname) %(refname)'],source,false)).split('\n').filter(Boolean).map(l=>{const [oid,ref]=l.split(' ');if(!/^[a-f0-9]{40}$/.test(oid)||!ref.startsWith('refs/'))throw Error('Invalid source ref');return {oid,ref};});
const exportedRefs=allRefs.filter(r=>!/^refs\/(heads|tags)\//.test(r.ref));
if(JSON.stringify(exportedRefs)!==JSON.stringify(c.exportedRefs??[]))throw Error('Unsupported refs require exact acknowledged export manifest');
const refs=allRefs.filter(r=>/^refs\/(heads|tags)\//.test(r.ref));
if(!refs.some(r=>r.ref==='refs/heads/main'))throw Error('Expected default main');
await client.git(['fsck','--full'],source,false);
const objects=await client.git(['rev-list','--objects','--all'],source,false);
const roots=(await client.git(['rev-list','--max-parents=0','--all'],source,false)).split('\n').filter(Boolean);
const pubkey=nostr.nip19.decode(client.coordinate.actor).data;
const events=[{kind:30617,content:'',tags:[['d',client.coordinate.identifier],['name',client.coordinate.identifier],['description',c.description??'Migrated repository; original history preserved'],['clone',client.root],['relays',client.relay],['web'],['r',roots[0],'euc'],['alt','git repository: '+client.coordinate.identifier],['private','true']]},{kind:30618,content:'',tags:[['d',client.coordinate.identifier],['HEAD','ref: refs/heads/main'],...refs.map(r=>[r.ref,r.oid])]}];
const plan={source,destination:client.root,refs,exportedRefs,rootCommits:roots,objectsSha256:createHash('sha256').update(objects).digest('hex'),configHash:hash,events};
function save(name:string,data:unknown){writeFileSync(directory+'/'+name,JSON.stringify(data,null,2)+'\n',{mode:0o600});}
save('plan.json',plan);
if(mode==='plan'){console.log(JSON.stringify(plan,null,2));process.exit(0);}
if(c.sourcePrivate===false)throw Error('Public source requires a separate public service and preserved anonymous access; private import refused');
if(c.lfsRequired)throw Error('LFS transport not supported by this GRasp image; retain source and export objects before any cutover');
if(mode==='publish'||mode==='resume'){
 const previous=existsSync(directory+'/signed-events.json');
 if(mode==='publish'&&previous)throw Error('Prior publication attempt exists: inspect live state and use resume/verify; never blindly replay');
 if(mode==='resume'&&!previous)throw Error('No previous publication to resume');
 const prior=await client.query({kinds:[30617],authors:[pubkey],'#d':[client.coordinate.identifier]});
 if(mode==='publish'&&prior.length)throw Error('Destination coordinate already exists; preserve it');
 let signed:any[];
 if(mode==='resume'){
  signed=JSON.parse(readFileSync(directory+'/signed-events.json','utf8'));
  if(signed.length!==events.length||signed.some((e,i)=>!nostr.verifyEvent(e)||e.pubkey!==pubkey||e.kind!==events[i].kind||e.content!==events[i].content||JSON.stringify(e.tags)!==JSON.stringify(events[i].tags)))throw Error('Saved event/plan binding mismatch');
  if(prior.some(e=>e.id!==signed[0].id))throw Error('Destination changed since attempt');
  const advertised=await client.git(['ls-remote','--refs',client.root],source);
  for(const line of advertised.split('\n').filter(Boolean)){const [oid,ref]=line.split(/\s+/);if(!refs.some(r=>r.ref===ref&&r.oid===oid))throw Error('Concurrent destination ref change; resume refused');}
 }else{signed=[];for(const e of events)signed.push(await client.sign(e));}
 await client.credential();
 const anonymous=await client.http('/info/refs?service=git-upload-pack');if(anonymous.status!==401||anonymous.body!=='')throw Error('Anonymous private denial failed');
 if(!previous)save('signed-events.json',signed);
 const acks=[];for(const e of signed)acks.push(await client.publish(e));save('publish-acks.json',acks);
 await client.git(['push','--porcelain',client.root,...refs.map(r=>r.oid+':'+r.ref)],source);
}
const remote=await client.git(['ls-remote','--refs',client.root],source);
const normalize=(lines:string)=>lines.split('\n').filter(Boolean).map(l=>l.trim().split(/\s+/).join(' ')).sort().join('\n');
if(normalize(remote)!==normalize(refs.map(r=>r.oid+' '+r.ref).join('\n')))throw Error('Destination ref parity failed');
const readback=directory+'/readback.git';if(existsSync(readback))throw Error('Readback exists: use a fresh verify config directory');
await client.git(['clone','--bare',client.root,readback],directory);
await client.git(['fsck','--full'],readback,false);
const actual=await client.git(['rev-list','--objects','--all'],readback,false);
const objectIds=(v:string)=>v.split('\n').filter(Boolean).map(l=>l.split(' ')[0]).sort().join('\n');
if(objectIds(actual)!==objectIds(objects))throw Error('Reachable object parity failed');
const state=await client.query({kinds:[30618],authors:[pubkey],'#d':[client.coordinate.identifier]});
if(!state.some(e=>refs.every(r=>e.tags.some((t:string[])=>t[0]===r.ref&&t[1]===r.oid))))throw Error('Signed state readback failed');
save('verification.json',{verified_at:new Date().toISOString(),refs:refs.length,objects:objectIds(actual).split('\n').length,fsck:true,freshClone:true,signedState:true,sourceUnchanged:true,consumerCutover:false});
console.log(client.coordinate.identifier+': fresh clone, refs and reachable objects verified');
