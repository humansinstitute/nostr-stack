import {constants} from 'node:fs';
import {lstat,open,realpath,unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {hostServiceLabel} from '../src/installation/host-service';
import {validateProject} from './nstack-recovery';

const PROJECT='com.docker.compose.project', MODULE='io.wingman.nstack.module', MANAGED='io.wingman.nstack.managed';
const modules=['graph','relay','blossom','git'];
type Resource=Record<string,any>;
export interface Snapshot {containers:Resource[];volumes:Resource[];networks:Resource[];daemon?:string}
export type Run=(args:string[])=>Promise<string>;
export async function run(args:string[]):Promise<string>{
 const child=Bun.spawn(args,{stdout:'pipe',stderr:'pipe'});
 const timer=setTimeout(()=>child.kill(),30000);
 try{const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 if(code!==0)throw Error(`${args.slice(0,3).join(' ')} failed: ${err.trim()||out.trim()||'exit '+code}. Check access/runtime and retry the same project.`);
 return out.trim();}finally{clearTimeout(timer);}
}
export async function inspectDocker(exec:Run=run):Promise<Snapshot>{
 const daemon=await exec(['docker','info','--format','{{.ID}}']);
 if(!daemon)throw Error('Docker daemon identity unavailable.');
 const inspect=async(kind:string,list:string[])=>{const ids=(await exec(['docker',...list])).split('\n').filter(Boolean);return ids.length?JSON.parse(await exec(['docker',...(kind? [kind]:[]),'inspect',...ids])):[];};
 // Inspect all consumers, including stopped containers. A failed inspection is never an empty installation.
 return {daemon,containers:await inspect('', ['ps','-aq','--no-trunc']),volumes:await inspect('volume',['volume','ls','-q']),networks:await inspect('network',['network','ls','-q'])};
}
function labels(r:Resource,container=false){return (container?r.Config?.Labels:r.Labels)||{};}
function owned(l:Resource,project:string,kind:string){
 if(l[PROJECT]!==project)return false;
 if(l[MODULE]||l[MANAGED]){
  if(l[MANAGED]!=='v1'||!modules.includes(l[MODULE]))throw Error(`Unverified ${kind} module labels; refusing removal.`);
 }else if(!l['com.docker.compose.'+(kind==='container'?'service':kind==='volume'?'volume':'network')])throw Error(`Ambiguous ${kind} with project label; refusing removal.`);
 return true;
}
function stopTimeout(service:string){return ['postgres','minio','seaweedfs','graph'].includes(service)?-1:20;}
export function planRemoval(project:string,s:Snapshot){
 validateProject(project);
 const containers=s.containers.filter(c=>owned(labels(c,true),project,'container'));
 for(const c of containers){const l=labels(c,true);
  // Compose orphans are included only when their original config is this installation bundle.
  if(!l[MODULE]&&(!l['com.docker.compose.project.config_files']?.split(',').every((p:string)=>basename(p)==='docker-compose.setup.yml')))throw Error(`Container ${c.Id} has foreign/unknown Compose provenance; refusing removal.`);
 }
 const volumes=s.volumes.filter(v=>owned(labels(v),project,'volume'));
 const networks=s.networks.filter(n=>owned(labels(n),project,'network'));
 const ids=new Set(containers.map(c=>c.Id)),vs=new Set(volumes.map(v=>v.Name)),ns=new Set(networks.map(n=>n.Id));
 for(const v of volumes)if(v.Driver!=='local'||Object.keys(v.Options||{}).length)throw Error(`Volume ${v.Name} has an external/custom driver; refusing removal.`);
 for(const c of s.containers){
  for(const m of c.Mounts||[]){
   if(m.Type==='volume'&&vs.has(m.Name)&&!ids.has(c.Id))throw Error(`Shared volume ${m.Name} is used by foreign container ${c.Id}; detach it explicitly first.`);
   if(ids.has(c.Id)&&!(m.Type==='volume'&&vs.has(m.Name))&&!(m.Type==='bind'&&m.Source==='/var/run/docker.sock'&&m.Destination==='/var/run/docker.sock'&&labels(c,true)['com.docker.compose.service']==='controller')&&m.Type!=='tmpfs')throw Error(`Foreign mount on ${c.Id} at ${m.Destination}; refusing removal.`);
  }
  for(const n of Object.values(c.NetworkSettings?.Networks||{}) as Resource[]){
   if(ns.has(n.NetworkID)&&!ids.has(c.Id))throw Error(`Shared network ${n.NetworkID} has foreign container ${c.Id}; detach it explicitly first.`);
   if(ids.has(c.Id)&&!ns.has(n.NetworkID))throw Error(`Foreign network ${n.NetworkID} on ${c.Id}; refusing removal.`);
  }
 }
 for(const n of networks)for(const id of Object.keys(n.Containers||{}))if(!ids.has(id))throw Error(`Network ${n.Id} has foreign endpoint ${id}; refusing removal.`);
 return {containers:containers.map(c=>({id:c.Id,name:c.Name,service:labels(c,true)[MODULE]||labels(c,true)['com.docker.compose.service'],stop_timeout_seconds:stopTimeout(labels(c,true)[MODULE]||labels(c,true)['com.docker.compose.service'])})),networks:networks.map(n=>({id:n.Id,name:n.Name})),volumes:volumes.map(v=>v.Name).sort()};
}

// Verify every parent too: neither an archive binding nor HOME may redirect deletion through a symlink.
export async function privateFile(path:string){
 for(let p=dirname(path);;p=dirname(p)){
  const st=await lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(st&&(!st.isDirectory()||st.isSymbolicLink()))throw Error(`Unsafe parent directory: ${p}`);
  if(p===dirname(p))break;
 }
 try{
  const stat=await lstat(path);
  if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw Error(`Unsafe/unowned private file: ${path}`);
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const st=await f.stat();if(st.ino!==stat.ino||st.dev!==stat.dev)throw Error('File changed; retry.');return {path,ino:st.ino,dev:st.dev,text:await f.readFile('utf8')};}finally{await f.close();}
 }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
}
type FileProof=NonNullable<Awaited<ReturnType<typeof privateFile>>>;
async function removeFile(proof:FileProof){const now=await privateFile(proof.path);if(!now||now.ino!==proof.ino||now.dev!==proof.dev||now.text!==proof.text)throw Error(`File changed: ${proof.path}; retry.`);await unlink(proof.path);}
export async function recoveryProof(root:string,project:string){
 const proof=await privateFile(join(root,`nstack-${project}-setup.txt`));
 if(proof&&!new RegExp(`^NStack recovery v1 ${project} npub1[a-z0-9]+$`).test(proof.text.split('\n')[0]!))throw Error(`Recovery file does not match installation ${project}: ${proof.path}`);
 return proof;
}
export async function verifyRecovery(proof:FileProof,project:string,s:Snapshot,exec:Run){
 const identity=proof.text.split('\n')[0]!.split(' ').at(-1);
 const volumes=s.volumes.filter(v=>v.Labels?.[PROJECT]===project&&v.Labels?.['com.docker.compose.volume']==='bootstrap');
 const lines=proof.text.split('\n').filter(l=>l.startsWith('Docker binding v1 '));
 const towers=s.containers.filter(c=>labels(c,true)[PROJECT]===project&&labels(c,true)['com.docker.compose.service']==='tower');
 if(volumes.length!==1)throw Error('Recovery identity cannot be verified without one durable bootstrap volume. Preserve the file and recover the intended installation first.');
 const volume=volumes[0]!;
 if(!s.daemon||typeof volume.CreatedAt!=='string')throw Error('Durable volume/daemon identity unavailable; refusing recovery deletion.');
 let bound=false;
 if(lines.length){
  if(lines.length!==1)throw Error('Ambiguous recovery Docker binding.');
  const binding=JSON.parse(lines[0]!.slice('Docker binding v1 '.length));
  if(binding.daemon!==s.daemon||binding.volume!==volume.Name||binding.created!==volume.CreatedAt)throw Error('Recovery file belongs to another Docker context or durable installation; refusing deletion.');
  bound=true;
 }
 if(towers.length>1)throw Error('Ambiguous NStack identity; refusing recovery deletion.');
 if(towers.length===1){
  const tower=towers[0]!;
  if(!tower.Mounts?.some((m:Resource)=>m.Type==='volume'&&m.Name===volume.Name&&m.Destination==='/run/nstack'))throw Error('NStack bootstrap mount mismatch.');
  // Docker archive reads also work for stopped containers. No reader container or write is needed.
  const tar=Buffer.from(await exec(['docker','cp',tower.Id+':/run/nstack/bootstrap.json','-']),'utf8');
  let state:Resource|undefined;
  for(let offset=0;offset+512<=tar.length;){
   const header=tar.subarray(offset,offset+512),size=parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,'').trim(),8);
   if(!Number.isFinite(size)||size<0)break;
   const name=header.subarray(0,100).toString().replace(/\0.*$/s,'');
   if(name.split('/').at(-1)==='bootstrap.json')state=JSON.parse(tar.subarray(offset+512,offset+512+size).toString());
   offset+=512+Math.ceil(size/512)*512;
  }
  if(!state||state.service_npub!==identity)throw Error('Recovery file identity does not match selected installation; refusing deletion.');
  bound=true;
 }
 if(!bound)throw Error('Legacy recovery file has no verifiable Docker binding. Run setup/recovery with the same project on the intended Docker context, then retry purge. No files were deleted.');
}
async function helperState(label:string,exec:Run){
 if(process.platform==='darwin'){
  // launchctl uses 113 exclusively for an absent service; other errors must fail closed.
  const result=await exec(['sh','-c','out=$(launchctl print "$1" 2>&1); code=$?; if [ "$code" = 113 ]; then printf absent; elif [ "$code" = 0 ]; then printf "%s" "$out"; else printf "%s" "$out" >&2; exit "$code"; fi','nstack',`gui/${process.getuid!()}/${label}`]);
  return {active:result!=='absent',pid:Number(result.match(/\bpid = (\d+)/)?.[1])||null,detail:result};
 }
 const result=await exec(['systemctl','--user','show',label+'.service','--property=LoadState,ActiveState,MainPID,ExecStart']);
 if(!/LoadState=(loaded|not-found)/.test(result))throw Error('Cannot inspect user service; check systemctl --user access.');
 return {active:/ActiveState=(active|activating|deactivating)/.test(result),pid:Number(result.match(/MainPID=(\d+)/)?.[1])||null,detail:result};
}
export async function helperProof(project:string,exec:Run,home=homedir()){
 if(!['darwin','linux'].includes(process.platform))throw Error('Removal supports macOS and Linux user services.');
 const label=hostServiceLabel(project),path=process.platform==='darwin'?join(home,'Library/LaunchAgents',label+'.plist'):join(home,'.config/systemd/user',label+'.service');
 const proof=await privateFile(path),state=await helperState(label,exec);
 let boundRoot:string|null=null;
 if(proof){
  let script:string;
  if(process.platform==='darwin'){
   const plist=JSON.parse(await exec(['plutil','-convert','json','-o','-',path]));const a=plist.ProgramArguments;
   if(plist.Label!==label||!Array.isArray(a)||a.length!==4||a[2]!=='supervise'||a[3]!==project)throw Error('Helper registration does not match installation.');
   script=a[1];
  }else{
   const line=proof.text.split('\n').filter(l=>l.startsWith('ExecStart='));
   const m=line.length===1?line[0]!.match(/^ExecStart="[^"\n]+" "([^"\n]+)" "supervise" "([a-z0-9_-]+)"$/):null;
   if(!m||m[2]!==project)throw Error('Unknown helper binding; refusing removal.');script=m[1]!;
  }
  const suffix=new RegExp(`/\\.runtime/installations/${project}/revisions/[a-f0-9]{64}/scripts/nstack-host\\.js$`);
  if(!script.startsWith('/')||!suffix.test(script))throw Error('Unknown helper archive binding; refusing removal.');
  if(state.active&&!state.detail.includes(script))throw Error('Running helper differs from service file; refusing removal.');
  boundRoot=script.replace(suffix,'');
  // Binding may point into an old archive. Only its exact service file and matching recovery file can be unlinked.
  try{if(await realpath(boundRoot)!==boundRoot)throw Error('Unsafe helper archive root.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 }else if(state.active)throw Error('Running helper has no verified service file; refusing removal.');
 return {label,proof,state,boundRoot};
}
async function stopHelper(h:Awaited<ReturnType<typeof helperProof>>,exec:Run){
 if(h.state.active){
  await exec(process.platform==='darwin'?['launchctl','bootout',`gui/${process.getuid!()}/${h.label}`]:['systemctl','--user','stop',h.label+'.service']);
 }
 if(process.platform==='linux'&&h.proof)await exec(['systemctl','--user','disable',h.label+'.service']);
 if((await helperState(h.label,exec)).active)throw Error('Helper still registered/running; no Docker resources removed.');
 if(h.state.pid){for(let i=0;i<50;i++){try{process.kill(h.state.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')break;throw e;}if(i===49)throw Error('Helper process has not exited; retry after it stops.');await Bun.sleep(100);}}
 if(h.proof)await removeFile(h.proof);
 if(process.platform==='linux'&&h.proof)await exec(['systemctl','--user','daemon-reload']);
}
export function parseArgs(args:string[]){
 const projects=args.filter(a=>!a.startsWith('-'));
 if(projects.length!==1||args.some(a=>a.startsWith('-')&&!['--purge','--dry-run'].includes(a)))throw Error('Usage: bun run nstack:rm <project> [--dry-run] [--purge]. Explicit project required; there is no default.');
 validateProject(projects[0]!);return {project:projects[0]!,purge:args.includes('--purge'),dryRun:args.includes('--dry-run')};
}
export async function removeInstallation(options:{project:string;purge:boolean;dryRun:boolean},root=resolve(import.meta.dir,'..'),exec:Run=run){
 validateProject(options.project);const {project,purge,dryRun}=options;
 let phase='preflight';const completed:string[]=[];
 try{
  const snapshot=await inspectDocker(exec);
  const plan=planRemoval(project,snapshot);
  const recheck=async()=>{
   const state=await inspectDocker(exec);
   if(state.daemon!==snapshot.daemon)throw Error('Docker context/daemon changed; refusing further removal.');
   for(const name of plan.volumes){const before=snapshot.volumes.find(v=>v.Name===name),now=state.volumes.find(v=>v.Name===name);if(now&&now.CreatedAt!==before?.CreatedAt)throw Error(`Volume ${name} was recreated; refusing further removal.`);}
   return planRemoval(project,state);
  };
  const helper=await helperProof(project,exec);
  const recovery:FileProof[]=[];
  if(purge)for(const folder of new Set([root,...(helper.boundRoot?[helper.boundRoot]:[])])){const p=await recoveryProof(folder,project);if(p){await verifyRecovery(p,project,snapshot,exec);recovery.push(p);}}
  const activeVolumeMounts=new Set<string>();
  for(const c of snapshot.containers){
   const isRunning=c.State?.Running===true||c.State?.Status==='running'||c.State?.Status==='restarting';
   if(isRunning&&plan.containers.some(p=>p.id===c.Id)){
    for(const m of c.Mounts||[])if(m.Type==='volume'&&m.Name)activeVolumeMounts.add(m.Name);
   }
  }
  const retainedColdVolumes=plan.volumes.filter(name=>{
   const v=snapshot.volumes.find(x=>x.Name===name);
   const volKey=v?.Labels?.['com.docker.compose.volume'];
   return (volKey==='storage'||volKey==='storage-seaweedfs')&&!activeVolumeMounts.has(name);
  });
  const preview={project,dry_run:dryRun,purge,helper:{label:helper.label,config:helper.proof?.path||null,active:helper.state.active},containers:plan.containers,networks:plan.networks,delete_volumes:purge?plan.volumes:[],preserve_volumes:purge?[]:plan.volumes,retained_cold_volumes:retainedColdVolumes,delete_recovery_files:recovery.map(p=>p.path),stop_policy:'Applications: Docker may terminate an unresponsive process after 20 seconds; module relay/blossom/git may need crash recovery on restart. Datastores (postgres/minio/seaweedfs/graph): no automatic forced termination; bounded client wait fails partial.',warning:purge?'PERMANENT LOSS: installation data, credentials and identity will be deleted.':'Data, credentials, identity and recovery files are retained. Same project name is ONE installation across source versions.'};
  console.log(JSON.stringify(preview,null,2));if(dryRun)return preview;
  phase='stop/uninstall helper';completed.push('helper uninstall attempted (verify status if this step fails)');await stopHelper(helper,exec);completed.push('helper stopped/uninstalled');
  // Stop the controller first so it cannot recreate optional modules during teardown.
  // Datastores never auto-escalate to SIGKILL; application grace supports legacy PID1 runtimes.
  // The bounded client deadline fails partial, and plain rm never deletes a running container.
  phase='stop controller';for(const c of plan.containers.filter(c=>c.service==='controller'))await exec(['docker','stop','--timeout='+c.stop_timeout_seconds,c.id]);
  assertSame(plan,await recheck());
  for(const c of plan.containers){phase=`remove container ${c.id}`;const current=await recheck();if(!current.containers.some(x=>x.id===c.id))throw Error('Container inventory changed; retry.');phase=`stop container ${c.id}`;await exec(['docker','stop','--timeout='+c.stop_timeout_seconds,c.id]);completed.push(phase);phase=`remove container ${c.id}`;await exec(['docker','rm',c.id]);completed.push(phase);}
  for(const n of plan.networks){phase=`remove network ${n.id}`;await recheck();await exec(['docker','network','rm',n.id]);completed.push(phase);}
  if(purge){
   // Unlink verified recovery first: a later volume failure must remain safely retryable.
   for(const p of recovery){phase=`remove recovery ${p.path}`;await removeFile(p);completed.push(phase);}
   for(const v of plan.volumes){phase=`purge volume ${v}`;const current=await recheck();if(!current.volumes.includes(v)||current.containers.length)throw Error('Installation inventory changed; retry.');await exec(['docker','volume','rm',v]);completed.push(phase);}
  }
  phase='final verification';const remaining=await recheck();
  if(remaining.containers.length||remaining.networks.length||(purge&&remaining.volumes.length)||(await helperState(helper.label,exec)).active)throw Error('Resources remain or were recreated; retry.');
  console.log(`Removed installation ${project}${purge?' including data and identity':' (data and identity preserved)'}.`);return preview;
 }catch(e){throw Error(`Removal failed during ${phase}. ${completed.length?'Partial completion: '+completed.join('; ')+'.':'No removal steps completed.'} ${e instanceof Error?e.message:String(e)} Inspect the reported resources, resolve the cause, and rerun the same project.`,{cause:e});}
}
function assertSame(a:ReturnType<typeof planRemoval>,b:ReturnType<typeof planRemoval>){if(JSON.stringify(a)!==JSON.stringify(b))throw Error('Installation inventory changed after preflight; retry.');}
if(import.meta.main){
 if(process.argv.slice(2).some(a=>a==='--help'||a==='-h'))console.log('Usage: bun run nstack:rm <project> [--dry-run] [--purge]\nExplicit validated project required. Same name = ONE installation across all source versions.\nDefault: uninstall project helper, containers and networks; preserve volumes, data and identity.\n--dry-run: inspect and preview exact resources, without writes or stopping helpers.\n--purge: PERMANENTLY DELETE exclusive installation volumes, credentials, identity and matching private recovery files.\nNever removes source folders, images, build cache, shared FIPS daemon or Autopilot.');
 else try{await removeInstallation(parseArgs(process.argv.slice(2)));}catch(e){console.error((e as Error).message);process.exitCode=1;}
}
