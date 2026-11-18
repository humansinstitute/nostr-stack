import {test,expect,beforeEach,afterEach} from 'bun:test';
import {mkdtemp,realpath,mkdir,writeFile,symlink,chmod,link,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyRecovery,helperProof,parseArgs,planRemoval,privateFile,recoveryProof,removeInstallation,type Snapshot,type Run} from '../scripts/nstack-remove';
const P='com.docker.compose.project',M='io.wingman.nstack.module',V='io.wingman.nstack.managed';
const label=(project='test')=>({[P]:project});
function fixture(project='test'):Snapshot{return {containers:[{Id:project+'-id',Name:'/'+project+'-tower-1',Config:{Labels:{...label(project),'com.docker.compose.service':'tower','com.docker.compose.project.config_files':'/old/archive/docker-compose.setup.yml'}},Mounts:[{Type:'volume',Name:project+'-data',Destination:'/run/nstack'}],NetworkSettings:{Networks:{default:{NetworkID:project+'-net'}}}}],volumes:[{Name:project+'-data',CreatedAt:'2026-11-18T00:00:00Z',Driver:'local',Labels:{...label(project),'com.docker.compose.volume':'bootstrap'}}],networks:[{Id:project+'-net',Name:project+'-default',Labels:{...label(project),'com.docker.compose.network':'default'},Containers:{[project+'-id']:{}}}]};}
function combine(a:Snapshot,b:Snapshot):Snapshot{return {containers:[...a.containers,...b.containers],volumes:[...a.volumes,...b.volumes],networks:[...a.networks,...b.networks]};}
function fake(initial:Snapshot,fail=''){
 const state=structuredClone(initial),calls:string[][]=[];
 const exec:Run=async a=>{calls.push(a);const cmd=a.join(' ');
  if(fail&&cmd.includes(fail))throw Error('injected '+fail);
  if(a[0]==='sh')return 'absent';if(a[0]==='systemctl')return 'LoadState=not-found\nActiveState=inactive\nMainPID=0';
  if(a[1]==='info')return 'daemon';
  if(a[1]==='cp'){const content=JSON.stringify({service_npub:'npub1abc'}),header=Buffer.alloc(512);header.write('bootstrap.json');header.write(Buffer.byteLength(content).toString(8).padStart(11,'0')+'\0',124);return Buffer.concat([header,Buffer.from(content),Buffer.alloc(512-content.length)]).toString();}
  if(a[1]==='ps')return state.containers.map(c=>c.Id).join('\n');
  if(a[1]==='inspect')return JSON.stringify(state.containers.filter(c=>a.slice(2).includes(c.Id)));
  if(a[2]==='ls')return (a[1]==='volume'?state.volumes.map(v=>v.Name):state.networks.map(n=>n.Id)).join('\n');
  if(a[2]==='inspect')return JSON.stringify((a[1]==='volume'?state.volumes:state.networks).filter(r=>a.slice(3).includes(r.Id||r.Name)));
  if(a[1]==='rm'){state.containers=state.containers.filter(c=>c.Id!==a[3]);for(const n of state.networks)delete n.Containers?.[a[3]!];return '';}
  if(a[2]==='rm'){if(a[1]==='volume')state.volumes=state.volumes.filter(v=>v.Name!==a[3]);else state.networks=state.networks.filter(n=>n.Id!==a[3]);return '';}
  throw Error('unexpected '+cmd);
 };return {exec,state,calls};
}
let root:string,oldHome:string|undefined;
beforeEach(async()=>{root=await realpath(await mkdtemp(join(tmpdir(),'nstack-remove-')));oldHome=process.env.HOME;process.env.HOME=root;});
afterEach(async()=>{process.env.HOME=oldHome;await rm(root,{recursive:true,force:true});});
test('project is mandatory; options and unsafe names rejected before any effects',()=>{
 for(const args of [[],['--purge'],['../other'],['Test'],['test','other'],['test','--force']])expect(()=>parseArgs(args)).toThrow();
 expect(parseArgs(['test','--dry-run','--purge'])).toEqual({project:'test',dryRun:true,purge:true});
});
test('exact labels retain second installation and prefix collisions; Compose orphan and owned dynamic module included',()=>{
 const s=combine(fixture(),fixture('test-other'));const module={Id:'module',Config:{Labels:{...label(),[M]:'relay',[V]:'v1'}},Mounts:[],NetworkSettings:{Networks:{}}};s.containers.push(module);
 s.containers.push({...structuredClone(s.containers[0]!),Id:'orphan',Config:{Labels:{...s.containers[0]!.Config.Labels,'com.docker.compose.service':'old-service'}}});
 expect(planRemoval('test',s).containers.map(c=>c.id)).toEqual(['test-id','module','orphan']);
 expect(planRemoval('test',s).volumes).toEqual(['test-data']);
});
test('shared volume rejected even if consumer stopped; foreign mount/network and ambiguous labels rejected',()=>{
 for(const change of [(s:Snapshot)=>s.containers[1]!.Mounts.push({Type:'volume',Name:'test-data'}),(s:Snapshot)=>s.containers[0]!.Mounts.push({Type:'bind',Source:'/private',Destination:'/data'}),(s:Snapshot)=>s.containers[0]!.NetworkSettings.Networks.foreign={NetworkID:'other-net'},(s:Snapshot)=>s.networks[0]!.Containers.foreign={},(s:Snapshot)=>delete s.volumes[0]!.Labels['com.docker.compose.volume'],(s:Snapshot)=>s.containers[0]!.Config.Labels[V]='bad',(s:Snapshot)=>s.containers[0]!.Config.Labels['com.docker.compose.project.config_files']='/other/app.yml',(s:Snapshot)=>s.volumes[0]!.Options={device:'/shared'}]){
  const s=combine(fixture(),fixture('second'));change(s);expect(()=>planRemoval('test',s)).toThrow();
 }
});
test('private recovery rejects symlinks, hardlinks, public permissions, wrong project and parent symlinks',async()=>{
 const file=join(root,'nstack-test-setup.txt'),target=join(root,'target');await writeFile(target,'private',{mode:0o600});await symlink(target,file);await expect(recoveryProof(root,'test')).rejects.toThrow();await rm(file);
 await link(target,file);await expect(privateFile(file)).rejects.toThrow();await rm(file);
 await writeFile(file,'NStack recovery v1 wrong npub1abc\n',{mode:0o600});await expect(recoveryProof(root,'test')).rejects.toThrow();
 await writeFile(file,'NStack recovery v1 test npub1abc\n');await chmod(file,0o644);await expect(recoveryProof(root,'test')).rejects.toThrow();await chmod(file,0o600);
 await symlink(root,join(root,'alias'));await expect(recoveryProof(join(root,'alias'),'test')).rejects.toThrow();
 expect((await recoveryProof(root,'test'))?.path).toBe(file);
});
test('dry-run performs inspection only and retains files',async()=>{
 const f=fake(combine(fixture(),fixture('second')));await writeFile(join(root,'nstack-test-setup.txt'),'NStack recovery v1 test npub1abc\n',{mode:0o600});
 const before=JSON.stringify(f.state);await removeInstallation({project:'test',purge:true,dryRun:true},root,f.exec);
 expect(JSON.stringify(f.state)).toBe(before);expect(f.calls.every(a=>a[0]==='sh'||a[0]==='systemctl'||a.includes('cp')||a.includes('info')||a.includes('ps')||a.includes('ls')||a.includes('inspect'))).toBe(true);
 expect(await Bun.file(join(root,'nstack-test-setup.txt')).exists()).toBe(true);
});
test('Docker preflight failure never stops helper or mutates resources',async()=>{const f=fake(fixture(),'docker info');await expect(removeInstallation({project:'test',purge:true,dryRun:false},root,f.exec)).rejects.toThrow('No removal steps completed');expect(f.calls.length).toBe(1);});
test('default retains identity/data; purge and repeat touch only exact installation',async()=>{
 const f=fake(combine(fixture(),fixture('second'))),sentinel=JSON.stringify(fixture('second'));
 await removeInstallation({project:'test',purge:false,dryRun:false},root,f.exec);expect(f.state.volumes.length).toBe(2);
 await writeFile(join(root,'nstack-test-setup.txt'),'NStack recovery v1 test npub1abc\nDocker binding v1 '+JSON.stringify({daemon:'daemon',volume:'test-data',created:'2026-11-18T00:00:00Z'})+'\n',{mode:0o600});
 await removeInstallation({project:'test',purge:true,dryRun:false},root,f.exec);await removeInstallation({project:'test',purge:true,dryRun:false},root,f.exec);
 expect(JSON.stringify(f.state)).toBe(sentinel);expect(await Bun.file(join(root,'nstack-test-setup.txt')).exists()).toBe(false);
});
test('partial failure is actionable and rerun finishes without success claim',async()=>{
 const f=fake(fixture(),'docker network rm');await expect(removeInstallation({project:'test',purge:true,dryRun:false},root,f.exec)).rejects.toThrow('Partial completion');
 expect(f.state.containers).toHaveLength(0);expect(f.state.volumes).toHaveLength(1);
 const retry=fake(f.state);await removeInstallation({project:'test',purge:true,dryRun:false},root,retry.exec);expect(retry.state.volumes).toHaveLength(0);
});
test('dynamic module volumes/networks require both exact managed and module labels',()=>{
 const s=fixture();s.volumes.push({Name:'module-data',Driver:'local',Labels:{...label(),[M]:'git',[V]:'v1'}});s.networks.push({Id:'module-net',Name:'module-network',Labels:{...label(),[M]:'git',[V]:'v1'},Containers:{}});
 expect(planRemoval('test',s).volumes).toEqual(['module-data','test-data']);expect(planRemoval('test',s).networks).toHaveLength(2);
 s.volumes[1]!.Labels[M]='unknown';expect(()=>planRemoval('test',s)).toThrow();
});
test('unsafe helper service file is rejected before Docker mutation',async()=>{
 const f=fake(fixture());const directory=process.platform==='darwin'?join(root,'Library/LaunchAgents'):join(root,'.config/systemd/user');await mkdir(directory,{recursive:true});
 const file=join(directory,'studio.otherstuff.nstack.host.test'+(process.platform==='darwin'?'.plist':'.service'));
 await symlink(join(root,'elsewhere'),file);await expect(helperProof('test',f.exec,root)).rejects.toThrow('Unsafe/unowned');expect(f.state.containers).toHaveLength(1);
});
test('recovery deletion is bound to exact Docker daemon, durable volume generation and service identity',async()=>{
 const f=fake(fixture());const path=join(root,'nstack-test-setup.txt'),snapshot={...fixture(),daemon:'daemon'};
 const verify=async(text:string)=>{await writeFile(path,text,{mode:0o600});await verifyRecovery((await recoveryProof(root,'test'))!,'test',snapshot,f.exec);};
 await verify('NStack recovery v1 test npub1abc\n');
 await expect(verify('NStack recovery v1 test npub1wrong\n')).rejects.toThrow('identity does not match');
 for(const binding of [{daemon:'another-daemon',volume:'test-data',created:'2026-11-18T00:00:00Z'},{daemon:'daemon',volume:'test-data',created:'recreated'}])await expect(verify('NStack recovery v1 test npub1abc\nDocker binding v1 '+JSON.stringify(binding)+'\n')).rejects.toThrow('another Docker context');
 snapshot.containers=[];
 await expect(verify('NStack recovery v1 test npub1abc\n')).rejects.toThrow('Legacy recovery');
 await verify('NStack recovery v1 test npub1abc\nDocker binding v1 '+JSON.stringify({daemon:'daemon',volume:'test-data',created:'2026-11-18T00:00:00Z'})+'\n');
});
test('module-owned network attached to Tower and orphan module volumes are accepted',()=>{
 const s=fixture();s.networks.push({Id:'graph-net',Labels:{...label(),[M]:'graph',[V]:'v1'},Containers:{'test-id':{}}});s.containers[0]!.NetworkSettings.Networks.graph={NetworkID:'graph-net'};
 s.volumes.push({Name:'orphan-module-config',Driver:'local',Labels:{...label(),[M]:'graph',[V]:'v1'}});
 expect(planRemoval('test',s).networks).toHaveLength(2);expect(planRemoval('test',s).volumes).toContain('orphan-module-config');
});
test('actual CLI without project exits before invoking Docker',async()=>{
 const bin=join(root,'docker'),audit=join(root,'called');await writeFile(bin,'#!/bin/sh\nprintf called > "$REMOVE_AUDIT"\nexit 99\n',{mode:0o700});
 const p=Bun.spawn([process.execPath,join(import.meta.dir,'../scripts/nstack-remove.ts'),'--purge'],{env:{...process.env,PATH:root,REMOVE_AUDIT:audit},stdout:'pipe',stderr:'pipe'});
 const [code,error]=await Promise.all([p.exited,new Response(p.stderr).text()]);expect(code).toBe(1);expect(error).toContain('Explicit project required');expect(await Bun.file(audit).exists()).toBe(false);
});
test('volume purge failure reports removed recovery accurately and is safely retryable',async()=>{
 const f=fake(fixture(),'docker volume rm');await writeFile(join(root,'nstack-test-setup.txt'),'NStack recovery v1 test npub1abc\n',{mode:0o600});
 await expect(removeInstallation({project:'test',purge:true,dryRun:false},root,f.exec)).rejects.toThrow('remove recovery');expect(await Bun.file(join(root,'nstack-test-setup.txt')).exists()).toBe(false);expect(f.state.volumes).toHaveLength(1);
 const retry=fake(f.state);await removeInstallation({project:'test',purge:true,dryRun:false},root,retry.exec);expect(retry.state.volumes).toHaveLength(0);
});
test('daemon switch and volume generation change after preflight stop further deletion',async()=>{
 for(const change of ['daemon','volume']){
  const f=fake(fixture());let info=0;const exec:Run=async a=>{if(a[1]==='info'&&++info===2){if(change==='daemon')return 'other-daemon';f.state.volumes[0]!.CreatedAt='recreated';}return f.exec(a);};
  await expect(removeInstallation({project:'test',purge:true,dryRun:false},root,exec)).rejects.toThrow(change==='daemon'?'context/daemon changed':'was recreated');expect(f.state.containers).toHaveLength(1);expect(f.state.volumes).toHaveLength(1);
 }
});
