import {describe,test,expect} from 'bun:test';
import {nip19} from 'nostr-tools';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {defaultModuleSettings,validateModuleSettings,moduleEnvironment,MODULE_CATALOGUE,type ModuleSettings} from '../src/installation/modules';
import {createModuleRuntime,type DockerRequest} from '../src/installation/module-runtime';
const key='1'.repeat(64),other='2'.repeat(64);
function configured():ModuleSettings {
 const m=defaultModuleSettings();
 m.graph.enabled=true;m.relay={enabled:true,origin:'wss://relay.example.com',publishers:[key]};m.blossom={enabled:true,origin:'https://blossom.example.com',publisher:key};m.git={enabled:true,origin:'https://git.example.com',members:[key],maintainers:[key],repository_readers:{[nip19.npubEncode(key)+'/repo']:[key]}};
 return m;
}
function fakeDocker(){
 const containers=new Map<string,any>(),networks=new Map<string,any>(),volumes=new Map<string,any>(),execs=new Map<string,any>();
 const calls:{path:string;method:string;body:any}[]=[];
 let seq=1;const id=()=>String(seq++).padStart(64,'0');
 let pullSucceeds=false;let missingImage='',failStart='',failProbe='',failRollback=false,failUpload=false;
 const ok=(x?:any)=>x===undefined?new Response(null,{status:204}):Response.json(x);
 const docker:DockerRequest=async(path,method='GET',body?:any)=>{
  calls.push({path,method,body});const u=new URL('http://docker'+path),p=u.pathname.split('/').filter(Boolean);
  if(p[0]==='images'){
   if(p[1]==='create'){if(pullSucceeds){missingImage='';return new Response(JSON.stringify({status:'Download complete'})+'\n');}return new Response(JSON.stringify({error:'fixture registry unavailable'})+'\n');}
   if(decodeURIComponent(p[1]).includes(missingImage)&&missingImage)return new Response('',{status:404});
   return ok({Id:'sha256:'+'a'.repeat(64),Config:{Labels:{'org.opencontainers.image.revision':'nstack-repository-access-v1'}}});
  }
  if(p[0]==='networks'||p[0]==='volumes'){
   const map=p[0]==='networks'?networks:volumes;
   if(p[1]==='create'){map.set(body.Name,{...structuredClone(body),Id:id()});return ok(body);}
   if(p[2]==='connect'||p[2]==='disconnect'){const network=[...map.values()].find(x=>x.Id===p[1]);const c=[...containers.values()].find(x=>x.Id===body.Container);c.NetworkSettings??={Networks:{}};if(p[2]==='connect')c.NetworkSettings.Networks[network.Name]={NetworkID:network.Id};else delete c.NetworkSettings.Networks[network.Name];return ok();}
   return map.has(p[1])?ok(map.get(p[1])):new Response('',{status:404});
  }
  if(p[0]==='containers'){
   if(p[1]==='json'){const filters=JSON.parse(u.searchParams.get('filters')??'{}');return ok([...containers.values()].filter(c=>(filters.label??[]).every((l:string)=>{const i=l.indexOf('=');return c.Config.Labels[l.slice(0,i)]===l.slice(i+1);})));}
   if(p[1]==='create'){
    const name=u.searchParams.get('name')!;if(containers.has(name))return new Response('',{status:409});
    const c={Id:id(),Name:name,Config:structuredClone(body),State:{Running:false},HostConfig:body.HostConfig};containers.set(name,c);return ok({Id:c.Id});
   }
   const c=[...containers.values()].find(c=>c.Id===p[1]||c.Name===p[1]);if(!c)return new Response('',{status:404});
   if(p[2]==='json')return ok(c);
   if(p[2]==='stop'){c.State.Running=false;return ok();}
   if(p[2]==='start'){
    if((failStart&&c.Config.Env?.some((v:string)=>v.includes(failStart)))||(failRollback&&c.Name.endsWith('relay')&&c.Config.Env.some((v:string)=>v.includes('relay.example.com'))))return new Response('',{status:500});
    c.State.Running=true;return ok();
   }
   if(p[2]==='rename'){containers.delete(c.Name);c.Name=u.searchParams.get('name');containers.set(c.Name,c);return ok();}
   if(p[2]==='archive')return failUpload?new Response('',{status:500}):ok();
   if(p[2]==='exec'){const e={Id:id(),container:c,cmd:body.Cmd};execs.set(e.Id,e);return ok({Id:e.Id});}
   if(method==='DELETE'){containers.delete(c.Name);return ok();}
  }
  if(p[0]==='exec'){
   const e=execs.get(p[1]);
   if(p[2]==='json'){const moduleFailure=Boolean(failProbe&&e.container.Config.Labels['io.wingman.nstack.module']===failProbe);const failed=moduleFailure||Boolean(failProbe&&e.container.Config.Env.some((v:string)=>v.includes(failProbe)));if(moduleFailure)failProbe='';return ok({Running:false,ExitCode:failed?1:0});}
   let data='';
   if(e.cmd.join(' ').includes('cat /run/module-state/admin-password /run/module-state/app-password'))data='a'.repeat(64)+'\n'+'b'.repeat(64)+'\n';
   else if(e.container.Config.Labels['io.wingman.nstack.module']==='git')data=JSON.stringify({supported_nips:[1,42]});
   const content=Buffer.from(data),header=Buffer.alloc(8);header[0]=1;header.writeUInt32BE(content.length,4);return new Response(Buffer.concat([header,content]));
  }
  throw Error('unhandled fake API '+method+' '+path);
 };
 return {docker,calls,containers,networks,volumes,allowPull:()=>pullSucceeds=true,setMissingImage:(s:string)=>missingImage=s,setStartFailure:(s:string)=>failStart=s,setProbeFailure:(s:string)=>failProbe=s,setRollbackFailure:()=>failRollback=true,setUploadFailure:()=>failUpload=true};
}
function runtime(f:ReturnType<typeof fakeDocker>){return createModuleRuntime({project:'test-installation',docker:f.docker,probeAttempts:1,probeDelayMs:0});}

describe('strict optional module configuration',()=>{
 test('all defaults off and independent',()=>{const a=defaultModuleSettings(),b=defaultModuleSettings();a.relay.publishers.push(key);expect(b.relay.publishers).toEqual([]);expect(validateModuleSettings(undefined)).toEqual(b);expect(Object.values(b).every(m=>!m.enabled)).toBe(true);});
 test('requires configuration before enable and rejects hidden authority',()=>{
  const m=defaultModuleSettings();m.relay.enabled=true;expect(()=>validateModuleSettings(m)).toThrow('relay_configuration_required');
  for(const field of ['image','command','mounts','env','password','secret'])expect(()=>validateModuleSettings({...configured(),[field]:'injection'})).toThrow();
  expect(()=>validateModuleSettings({...configured(),graph:{enabled:true,password:'x'}})).toThrow();
  expect(()=>validateModuleSettings({...configured(),relay:{...configured().relay,enabled:'true'}})).toThrow();
 });
 // Built at runtime so the synthetic userinfo rejection fixture is not a credential-URL literal in tracked source.
 const credentialOrigin=()=>{const u=new URL('https://example.com');u.username='fixture';u.password='fixture';return u.href.replace(/\/$/,'');};
 test('root transport origins are separate and secure',()=>{
  for(const origin of ['http://remote.example.com',credentialOrigin(),'https://example.com/path','https://example.com/','https://example.com?x=1'])expect(()=>validateModuleSettings({...configured(),blossom:{...configured().blossom,origin}})).toThrow();
  const m=configured();m.blossom.origin='https://relay.example.com';expect(()=>validateModuleSettings(m)).toThrow('module_origins_must_be_separate');
  m.blossom.origin='http://127.0.0.1:13002';expect(validateModuleSettings(m).blossom.origin).toBe(m.blossom.origin);
 });
 test('FIPS-only roots bind canonical peer and explicit per-service port',()=>{
  const peer=nip19.npubEncode(key),m=configured();
  m.relay.origin=`ws://${peer}.fips:17777`;m.blossom.origin=`http://${peer}.fips:13002`;m.git.origin=`http://${peer}.fips:17334`;
  expect(validateModuleSettings(m)).toEqual(m);
  for(const origin of [`ws://${peer}.fips`,`ws://npub1invalid.fips:17777`,`ws://${peer}.fips.evil.test:17777`,'https://relay.example.com'])expect(()=>validateModuleSettings({...m,relay:{...m.relay,origin}})).toThrow();
 });
 test('fixed relay renderer accepts validated FIPS root and preserves NIP42/allowlist',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'nstack-relay-config-'));
  try{
   const config=join(directory,'relay.toml'),origin=`ws://${nip19.npubEncode(key)}.fips:17777`;
   const child=Bun.spawn(['bash',fileURLToPath(new URL('../deploy/setup-modules/relay-entrypoint.sh',import.meta.url))],{env:{PATH:'/usr/bin:/bin',NOSTR_RELAY_PUBLIC_ORIGIN:origin,NOSTR_RELAY_PUBLISH_PUBKEYS:key,NOSTR_RELAY_VALIDATE_ONLY:'true',NOSTR_RELAY_CONFIG_PATH:config},stdout:'pipe',stderr:'pipe'});
   expect(await child.exited).toBe(0);const rendered=await readFile(config,'utf8');expect(rendered).toContain(`relay_url = "${origin}"`);expect(rendered).toContain(`pubkey_whitelist = ["${key}"]`);expect(rendered).toContain('nip42_auth = true');expect(rendered).toContain('nip42_dms = true');
  }finally{await rm(directory,{recursive:true,force:true});}
 });
 test('private Git readers can only narrow service membership',()=>{
  const m=configured();m.git.repository_readers[nip19.npubEncode(key)+'/repo']=[other];expect(()=>validateModuleSettings(m)).toThrow('repository_reader_outside_members');
  m.git.repository_readers={[nip19.npubEncode(key)+'/repo']:[key]};m.git.maintainers=[other];expect(()=>validateModuleSettings(m)).toThrow('maintainer_outside_members');
  m.git.maintainers=[key];m.git.repository_readers={'not-a-coordinate':[key]};expect(()=>validateModuleSettings(m)).toThrow('invalid_repository_coordinate');
 });
 test('metadata environment excludes protected graph values and every image is pinned',()=>{
  expect(Object.keys(moduleEnvironment(configured())).some(k=>/PASSWORD|NSEC|SECRET/.test(k))).toBe(false);
  expect(Object.values(MODULE_CATALOGUE).every(c=>/@sha256:[a-f0-9]{64}$/.test(c.image))).toBe(true);
 });
});

describe('fixed Docker lifecycle',()=>{
 test('enable, verify, disable by stop and reenable preserve IDs and volumes',async()=>{
  const f=fakeDocker(),r=runtime(f),on=configured(),off=defaultModuleSettings();
  expect((await r.apply(off,on)).state).toBe('committed');expect(await r.verify(on)).toBe(true);
  const ids=[...f.containers.values()].map(c=>c.Id);const volumes=[...f.volumes.keys()];
  expect((await r.apply(on,off)).state).toBe('committed');expect(await r.verify(off)).toBe(true);
  expect([...f.containers.values()].map(c=>c.Id)).toEqual(ids);expect([...f.containers.values()].every(c=>!c.State.Running)).toBe(true);
  expect((await r.apply(off,on)).state).toBe('committed');expect([...f.containers.values()].map(c=>c.Id)).toEqual(ids);expect([...f.volumes.keys()]).toEqual(volumes);
  expect(f.calls.some(c=>c.method==='DELETE'&&/^\/(volumes|networks)/.test(c.path))).toBe(false);
  for(const c of f.containers.values()){
   expect(c.Config.Image).toBe('sha256:'+'a'.repeat(64));expect(c.HostConfig.Mounts.every((m:any)=>m.Type==='volume'&&!m.Source.includes('/'))).toBe(true);
   expect(c.Config.Env.some((e:string)=>/NSEC|DB_PASSWORD|S3_SECRET/.test(e))).toBe(false);
   for(const binding of Object.values(c.HostConfig.PortBindings) as any[])expect(binding[0].HostIp).toBe('127.0.0.1');
  }
  expect(f.containers.get('test-installation-module-blossom').Config.Env).toContain('BLOSSOM_PUBLIC_DOMAIN=');
  expect(f.networks.get('test-installation-module-graph-network').Internal).toBe(true);
  expect(f.containers.get('test-installation-module-graph').HostConfig.PortBindings).toEqual({});
  const relay=f.containers.get('test-installation-module-relay');expect(relay.Config.Entrypoint).toEqual(['/bin/bash','/run/module-config/relay.sh']);
  const archives=f.calls.filter(c=>c.method==='PUT');expect(archives.length).toBe(4);
  expect(Buffer.from(archives.find(c=>c.path.includes(relay.Id))!.body).toString()).toContain('nip42_auth = true');
 });
 test('updates only changed module and retains persistent data',async()=>{
  const f=fakeDocker(),r=runtime(f),on=configured();await r.apply(defaultModuleSettings(),on);
  const old=f.containers.get('test-installation-module-relay').Id,graph=f.containers.get('test-installation-module-graph').Id;
  const changed=structuredClone(on);changed.relay.publishers=[other];expect((await r.apply(on,changed)).state).toBe('committed');
  expect(f.containers.get('test-installation-module-relay').Id).not.toBe(old);expect(f.containers.get('test-installation-module-graph').Id).toBe(graph);
  expect(f.volumes.has('test-installation-module-relay-data')).toBe(true);expect(f.containers.has('test-installation-module-relay-previous')).toBe(false);
 });
 test('failed readiness restores working container and configuration across multiple modules',async()=>{
  const f=fakeDocker(),r=runtime(f),on=configured();await r.apply(defaultModuleSettings(),on);
  const ids=[...f.containers.values()].map(c=>c.Id).sort();const changed=structuredClone(on);changed.relay.origin='wss://new-relay.example.com';changed.blossom.origin='https://bad.example.com';f.setProbeFailure('blossom');
  const result=await r.apply(on,changed);expect(result.state).toBe('rolled_back');expect(result.error).toBe('module_readiness_failed_blossom');
  expect([...f.containers.values()].map(c=>c.Id).sort()).toEqual(ids);expect(await r.verify(on)).toBe(true);
 });
 test('failure after disabling an earlier module restores its running state',async()=>{
  const f=fakeDocker(),r=runtime(f),on=configured();await r.apply(defaultModuleSettings(),on);
  const next=structuredClone(on);next.graph.enabled=false;next.relay.origin='wss://bad.example.com';f.setStartFailure('bad.example.com');
  expect((await r.apply(on,next)).state).toBe('rolled_back');expect(await r.verify(on)).toBe(true);
 });
 test('failed reenable restores disabled existing container without deleting its data',async()=>{
  const f=fakeDocker(),r=runtime(f),on=configured(),off=defaultModuleSettings();await r.apply(off,on);await r.apply(on,off);f.setProbeFailure('relay.example.com');
  expect((await r.apply(off,on)).state).toBe('rolled_back');expect([...f.containers.values()].every(c=>!c.State.Running)).toBe(true);expect(await r.verify(off)).toBe(true);
 });
 test('image provisioning fails before prior service is stopped',async()=>{
  const f=fakeDocker(),r=runtime(f),on=configured();await r.apply(defaultModuleSettings(),on);const before=f.calls.length;
  const next=structuredClone(on);next.relay.publishers=[other];f.setMissingImage('nostr-rs-relay');
  const result=await r.apply(on,next);expect(result.error).toBe('module_image_provision_failed_relay');expect(result.state).toBe('rolled_back');
  expect(f.calls.slice(before).some(c=>c.path.includes('/stop'))).toBe(false);expect(await r.verify(on)).toBe(true);
 });
 test('cold public image is provisioned only from fixed catalogue before service start',async()=>{
  const f=fakeDocker(),r=runtime(f),desired=defaultModuleSettings();desired.relay=configured().relay;f.setMissingImage('nostr-rs-relay');f.allowPull();
  expect((await r.apply(defaultModuleSettings(),desired)).state).toBe('committed');
  const pull=f.calls.find(c=>c.path.startsWith('/images/create?'));expect(pull?.path).toBe('/images/create?fromImage='+encodeURIComponent(MODULE_CATALOGUE.relay.image));
  const privateMissing=fakeDocker();privateMissing.setMissingImage('nstack-grasp');const git=defaultModuleSettings();git.git=configured().git;
  expect((await runtime(privateMissing).apply(defaultModuleSettings(),git)).error).toBe('module_image_distribution_unavailable_git');
  expect(privateMissing.calls.some(c=>c.path.startsWith('/images/create?'))).toBe(false);
 });
 test('foreign containers and volumes are not mutated',async()=>{
  const f=fakeDocker(),r=runtime(f),m=defaultModuleSettings();m.graph.enabled=true;
  f.volumes.set('test-installation-module-graph-data',{Labels:{'com.docker.compose.project':'another-project'}});
  expect((await r.apply(defaultModuleSettings(),m)).error).toBe('module_resource_not_owned');expect(f.calls.some(c=>c.path==='/containers/create')).toBe(false);
  f.containers.set('test-installation-module-graph',{Id:'1'.repeat(64),Name:'test-installation-module-graph',Config:{Labels:{}},State:{Running:true}});
  expect((await r.apply(defaultModuleSettings(),m)).error).toBe('module_resource_not_owned');expect(f.calls.some(c=>c.path.endsWith('/stop'))).toBe(false);
 });
 test('an interrupted replacement is recovered before reconciliation',async()=>{
  const f=fakeDocker(),r=runtime(f),on=configured();await r.apply(defaultModuleSettings(),on);
  const old=f.containers.get('test-installation-module-relay');f.containers.delete(old.Name);old.Name+='-previous';old.State.Running=false;f.containers.set(old.Name,old);
  expect((await r.apply(on,on)).state).toBe('committed');expect(f.containers.get('test-installation-module-relay').Id).toBe(old.Id);expect(await r.verify(on)).toBe(true);
 });
 test('rollback failures remain explicit and protected graph state is never in status',async()=>{
  const f=fakeDocker(),r=runtime(f),on=configured();await r.apply(defaultModuleSettings(),on);
  const env=await r.graphEnvironment();expect(env.GRAPH_DB_ADMIN_PASSWORD).toHaveLength(64);expect(env.GRAPH_DB_APP_PASSWORD).toHaveLength(64);expect(JSON.stringify(await r.status(on))).not.toContain(env.GRAPH_DB_ADMIN_PASSWORD);
  const next=structuredClone(on);next.relay.origin='wss://bad.example.com';f.setProbeFailure('blossom');f.setRollbackFailure();expect((await r.apply(on,next)).state).toBe('recovery_required');
 });
 test('optional Docker unavailability is reported as status, never thrown to core UI',async()=>{
  const r=createModuleRuntime({project:'test-installation',docker:async()=>{throw Error('docker_unavailable');}});
  expect((await r.status(defaultModuleSettings())).every(s=>s.runtime==='unavailable')).toBe(true);expect(await r.verify(defaultModuleSettings())).toBe(false);
 });
 test('Tower attachment uses exact project/service identity and only owned networks',async()=>{
  const f=fakeDocker(),r=runtime(f),on=configured();await r.apply(defaultModuleSettings(),on);
  await expect(r.connectTower(on)).rejects.toThrow('module_tower_container_ambiguous');
  const tower={Id:'f'.repeat(64),Name:'my-tower',Config:{Labels:{'com.docker.compose.project':'test-installation','com.docker.compose.service':'tower'}},State:{Running:true},NetworkSettings:{Networks:{'unrelated-network':{NetworkID:'e'.repeat(64)}}}};
  f.containers.set(tower.Name,tower);await r.connectTower(on);
  expect(Object.keys(tower.NetworkSettings.Networks).length).toBe(5);
  // A Compose recreation loses attachments, while desired module state stays.
  tower.NetworkSettings.Networks={'unrelated-network':{NetworkID:'f'.repeat(64)}};
  await r.connectTower(on);expect(Object.keys(tower.NetworkSettings.Networks)).toHaveLength(5);
  await r.initializeTowerGraph();expect(f.calls.some(c=>c.body?.Cmd?.join(' ').includes('exec bun run graph:init'))).toBe(true);
  await r.connectTower(defaultModuleSettings());expect(Object.keys(tower.NetworkSettings.Networks)).toEqual(['unrelated-network']);
  expect(f.calls.filter(c=>c.path.endsWith('/disconnect')).every(c=>c.body.Container===tower.Id&&c.body.Force===false)).toBe(true);
 });
 test('failed config upload rolls back and malformed input does not poison operation lock',async()=>{
  const f=fakeDocker(),r=runtime(f);await expect(r.apply(defaultModuleSettings(),{} as any)).rejects.toThrow();
  f.setUploadFailure();const result=await r.apply(defaultModuleSettings(),configured());expect(result.state).toBe('rolled_back');expect(f.containers.size).toBe(0);
 });
});

// Explicit opt-in: fixed loopback ports must be free. Only newly generated,
// label-scoped disposable resources are removed, never an existing installation.
test.skipIf(process.env.NSTACK_MODULE_DOCKER_TEST!=='1')('disposable Docker: four real services, auth denials, persistence and rollback',async()=>{
 const {generateSecretKey,getPublicKey,finalizeEvent}=await import('nostr-tools');
 const project='nstack-module-test-'+crypto.randomUUID().slice(0,8),idsToFail=new Set<string>();
 let failNewBlossom=false;
 const docker:DockerRequest=async(path,method='GET',body?:any)=>{
  if(method==='POST'&&path.startsWith('/containers/')&&path.endsWith('/start')&&idsToFail.delete(path.split('/')[2]))return new Response('',{status:503});
  const response=await fetch('http://localhost/v1.47'+path,{method,unix:'/var/run/docker.sock',headers:body instanceof Uint8Array?{'content-type':'application/x-tar'}:{'content-type':'application/json'},body:body===undefined?undefined:body instanceof Uint8Array?new Uint8Array(body).buffer:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  if(failNewBlossom&&path.startsWith('/containers/create')&&body?.Labels?.['io.wingman.nstack.module']==='blossom'&&response.ok){idsToFail.add((await response.clone().json()).Id);failNewBlossom=false;}
  return response;
 };
 const r=createModuleRuntime({project,docker,probeAttempts:60,probeDelayMs:1000});const off=defaultModuleSettings(),on=configured();
 const secret=generateSecretKey(),author=getPublicKey(secret);
 on.git={enabled:true,origin:'http://127.0.0.1:17334',members:[author],maintainers:[author],repository_readers:{[nip19.npubEncode(author)+'/private-test']:[author]}};
 on.relay={enabled:true,origin:'ws://127.0.0.1:17777',publishers:[author]};on.blossom={enabled:true,origin:'http://127.0.0.1:13002',publisher:author};
 const get=async(path:string)=>{const res=await docker(path);if(!res.ok)throw Error('docker_test_inspection_failed');return res.json();};
 const filter=encodeURIComponent(JSON.stringify({label:['com.docker.compose.project='+project,'io.wingman.nstack.managed=v1']}));
 try{
  const applied=await r.apply(off,on);expect(applied.state).toBe('committed');if(applied.state!=='committed')throw Error(applied.error);
  expect(await r.verify(on)).toBe(true);
  const containers=await get('/containers/json?all=1&filters='+filter),ids=containers.map((c:any)=>c.Id).sort();
  expect(ids.length).toBe(4);
  const credentials=await r.graphEnvironment();expect(credentials.GRAPH_DB_ADMIN_PASSWORD.length).toBe(64);
  const graph=await get('/containers/'+project+'-module-graph/json');expect(graph.HostConfig.PortBindings).toEqual({});
  const graphNetwork=await get('/networks/'+project+'-module-graph-network');expect(graphNetwork.Internal).toBe(true);
  const relayInfo=await(await fetch('http://127.0.0.1:17777/',{headers:{Accept:'application/nostr+json'}})).json();expect(relayInfo.supported_nips).toContain(42);
  const gitDenied=await fetch('http://127.0.0.1:17334/'+nip19.npubEncode(author)+'/private-test.git/info/refs?service=git-upload-pack');expect([401,403]).toContain(gitDenied.status);
  const blossomDenied=await fetch('http://127.0.0.1:13002/upload',{method:'PUT',body:'private-probe'});expect([401,403]).toContain(blossomDenied.status);
  // A signed non-allowlisted author cannot publish. Do not send real user data.
  const outsider=generateSecretKey(),event=finalizeEvent({kind:1,created_at:Math.floor(Date.now()/1000),tags:[],content:'disposable module ACL probe'},outsider);
  const denied=await new Promise<boolean>((resolve,reject)=>{
   const ws=new WebSocket('ws://127.0.0.1:17777');const timer=setTimeout(()=>{ws.close();reject(Error('relay_allowlist_probe_timeout'));},5000);
   ws.onopen=()=>ws.send(JSON.stringify(['EVENT',event]));ws.onmessage=e=>{const m=JSON.parse(String(e.data));if(m[0]==='OK'&&m[1]===event.id){clearTimeout(timer);ws.close();resolve(m[2]===false);}};ws.onerror=()=>{clearTimeout(timer);reject(Error('relay_probe_unavailable'));};
  });expect(denied).toBe(true);
  expect((await r.apply(on,off)).state).toBe('committed');expect(await r.verify(off)).toBe(true);
  expect((await get('/containers/json?all=1&filters='+filter)).map((c:any)=>c.Id).sort()).toEqual(ids);
  expect((await r.apply(off,on)).state).toBe('committed');const recovered=await r.graphEnvironment();expect(recovered.GRAPH_DB_ADMIN_PASSWORD===credentials.GRAPH_DB_ADMIN_PASSWORD).toBe(true);
  const changed=structuredClone(on);changed.relay.publishers=[other];changed.blossom.publisher=other;failNewBlossom=true;
  expect((await r.apply(on,changed)).state).toBe('rolled_back');expect(await r.verify(on)).toBe(true);
  expect((await get('/containers/json?all=1&filters='+filter)).map((c:any)=>c.Id).sort()).toEqual(ids);
  const helper=await (await docker('/containers/create?name='+project+'-tower-probe','POST',{Image:MODULE_CATALOGUE.graph.image,Entrypoint:['sleep'],Cmd:['120'],Labels:{'com.docker.compose.project':project,'com.docker.compose.service':'tower','io.wingman.nstack.managed':'v1'},HostConfig:{NetworkMode:'bridge'}})).json();
  await docker('/containers/'+helper.Id+'/start','POST');await r.connectTower(on);
  const connected=await get('/containers/'+helper.Id+'/json');for(const module of ['graph','relay','blossom','git'])expect(connected.NetworkSettings.Networks[project+'-module-'+module+'-network']).toBeDefined();
  await r.connectTower(off);expect(Object.keys((await get('/containers/'+helper.Id+'/json')).NetworkSettings.Networks)).toEqual(['bridge']);
 }finally{
  for(const c of await get('/containers/json?all=1&filters='+filter)){
   expect(c.Labels['com.docker.compose.project']).toBe(project);expect(c.Labels['io.wingman.nstack.managed']).toBe('v1');
   await docker('/containers/'+c.Id+'?force=1&v=0','DELETE');
  }
  for(const kind of ['networks','volumes']){
   const result=await get('/'+kind+'?filters='+filter);
   for(const v of Array.isArray(result)?result:result.Volumes??[]){expect(v.Labels['com.docker.compose.project']).toBe(project);await docker('/'+kind+'/'+(v.Id??v.Name),'DELETE');}
  }
 }
},180000);
