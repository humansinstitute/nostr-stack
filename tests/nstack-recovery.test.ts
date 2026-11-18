import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,chmod,realpath,readFile,writeFile,lstat,symlink,link,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveRecovery,validateProject,localPort,recoveryReadScript} from '../scripts/nstack-recovery';
const code='a'.repeat(48),url='http://127.0.0.1:3199/ui';
async function fixture(fn:(dir:string)=>Promise<void>){const dir=await realpath(await mkdtemp(join(tmpdir(),'nstack-recovery-')));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
test('private atomic files isolate projects and refresh claimed status without code',()=>fixture(async dir=>{
 const one=await saveRecovery(dir,'one','identity-one',url,false,code,true);
 const two=await saveRecovery(dir,'two','identity-two',url,false,'b'.repeat(48),false);
 expect((await lstat(one)).mode&0o777).toBe(0o600);expect(await readFile(one,'utf8')).toContain(code);
 const before=await lstat(one);await saveRecovery(dir,'one','identity-one',url,true,undefined,true);
 expect((await lstat(one)).ino).not.toBe(before.ino);expect((await lstat(one)).mode&0o777).toBe(0o600);
 expect(await readFile(one,'utf8')).not.toContain(code);expect(await readFile(one,'utf8')).toContain('already claimed');
 expect(await readFile(two,'utf8')).toContain('not ready');expect(await readFile(two,'utf8')).toContain('b'.repeat(48));
 expect((await readdir(dir)).length).toBe(2);
}));
test('preexisting symlink, hardlink and unrelated file never overwritten',()=>fixture(async dir=>{
 const target=join(dir,'other');await writeFile(target,'preserve');const path=join(dir,'nstack-one-setup.txt');
 await symlink(target,path);await expect(saveRecovery(dir,'one','id',url,false,code,true)).rejects.toThrow('Unsafe');expect(await readFile(target,'utf8')).toBe('preserve');await rm(path);
 await link(target,path);await expect(saveRecovery(dir,'one','id',url,false,code,true)).rejects.toThrow('Unsafe');await rm(path);
 await writeFile(path,'unrelated');await expect(saveRecovery(dir,'one','id',url,false,code,true)).rejects.toThrow('another installation');expect(await readFile(path,'utf8')).toBe('unrelated');
}));
test('same project from another installation and symlinked root refused',()=>fixture(async dir=>{
 const path=await saveRecovery(dir,'one','old-identity',url,false,code,true);
 await expect(saveRecovery(dir,'one','new-identity',url,false,code,true)).rejects.toThrow('another installation');expect(await readFile(path,'utf8')).toContain('old-identity');
 await symlink(dir,join(dir,'alias'));await expect(saveRecovery(join(dir,'alias'),'two','id',url,false,code,true)).rejects.toThrow('symlinks');
}));
test('invalid project paths and unknown ports have no default URL',()=>{
 for(const project of ['../x','x/y','','UPPER'])expect(()=>validateProject(project)).toThrow();
 expect(localPort(null)).toBeNull();expect(localPort({NetworkSettings:{Ports:{'3100/tcp':[{HostIp:'127.0.0.1',HostPort:'3199'}]}}})).toBe('3199');
});

// Run the real command with a read-only Docker fixture: no Compose/build/network.
for(const readiness of ['healthy','starting','stopped'])test('recovery command reports '+readiness+' using authoritative state',()=>fixture(async dir=>{
 await mkdir(join(dir,'scripts'));await writeFile(join(dir,'scripts/nstack-recovery.ts'),await readFile(join(import.meta.dir,'../scripts/nstack-recovery.ts')));
 const container={Id:'fixture',Config:{Labels:{'com.docker.compose.project':'one','com.docker.compose.service':'tower'}},State:{Running:readiness!=='stopped',Health:{Status:readiness}},Mounts:[{Destination:'/run/nstack',Type:'volume',Name:'one_bootstrap'}],NetworkSettings:{Ports:{'3100/tcp':[{HostIp:'127.0.0.1',HostPort:'3199'}]}}};
 const mock=join(dir,'docker');await writeFile(mock,`#!/bin/sh
case "$1" in
 ps) echo fixture;;
 inspect) cat "$FIXTURE_CONTAINER";;
 exec) cat "$FIXTURE_STATE";;
 *) exit 99;;
esac
`);await chmod(mock,0o755);
 await writeFile(join(dir,'container.json'),JSON.stringify([container]));await writeFile(join(dir,'state.json'),JSON.stringify({service_npub:'npub1fixture',claimed:false,code}));
 async function run(){const child=Bun.spawn([process.execPath,join(dir,'scripts/nstack-recovery.ts'),'one'],{env:{...process.env,PATH:dir+':/usr/bin:/bin',FIXTURE_CONTAINER:join(dir,'container.json'),FIXTURE_STATE:join(dir,'state.json')},stdout:'pipe',stderr:'pipe'});return {code:await child.exited,out:await new Response(child.stdout).text(),err:await new Response(child.stderr).text()};}
 const result=await run();
 if(readiness==='stopped'){expect(result.code).not.toBe(0);expect(result.err).toContain('startup was interrupted');expect(await readdir(dir)).not.toContain('nstack-one-setup.txt');return;}
 expect(result.code).toBe(0);expect(result.out).toContain(url);expect(result.out).not.toContain(code);
 expect(result.out).toContain(readiness==='healthy'?'Installation ready.':'Installation not ready yet');
 await writeFile(join(dir,'state.json'),JSON.stringify({service_npub:'npub1fixture',claimed:true}));expect((await run()).code).toBe(0);expect(await readFile(join(dir,'nstack-one-setup.txt'),'utf8')).not.toContain(code);
}));

test('setup saves before readiness completes and preserves existing port',()=>fixture(async dir=>{
 await mkdir(join(dir,'scripts'));await mkdir(join(dir,'docker'));await mkdir(join(dir,'bin'));
 const build=await Bun.build({entrypoints:[join(import.meta.dir,'../scripts/nstack-start.ts')],target:'bun',outdir:join(dir,'scripts'),naming:'nstack-start.js'});expect(build.success).toBe(true);
 await writeFile(join(dir,'source.json'),JSON.stringify({source_commit:'a'.repeat(40)}));
 await writeFile(join(dir,'docker/ensure-bun-base.sh'),'echo fixture-base');
 const container={Id:'fixture',Config:{Labels:{'com.docker.compose.project':'one','com.docker.compose.service':'tower'}},State:{Running:true,Health:{Status:'starting'}},Mounts:[{Destination:'/run/nstack',Type:'volume',Name:'one_bootstrap'}],NetworkSettings:{Ports:{'3100/tcp':[{HostIp:'127.0.0.1',HostPort:'3199'}]}}};
 await writeFile(join(dir,'container.json'),JSON.stringify([container]));await writeFile(join(dir,'state.json'),JSON.stringify({service_npub:'npub1fixture',claimed:false,code}));
 const mock=join(dir,'bin/docker');await writeFile(mock,`#!/bin/sh
case "$1" in
 ps) echo fixture;;
 inspect) cat "$FIXTURE_CONTAINER";;
 exec) cat "$FIXTURE_STATE";;
 compose)
  case "$*" in
   *'up -d'*)
    echo "$NSTACK_LOCAL_PORT" > "$FIXTURE_ROOT/port"
    i=0
    while [ ! -f "$FIXTURE_ROOT/nstack-one-setup.txt" ] && [ "$i" -lt 40 ]; do sleep 0.1; i=$((i+1)); done
    [ -f "$FIXTURE_ROOT/nstack-one-setup.txt" ] && echo saved > "$FIXTURE_ROOT/early"
    exit 1;;
  esac;;
esac
`);await chmod(mock,0o755);
 const child=Bun.spawn([process.execPath,join(dir,'scripts/nstack-start.js'),'one'],{env:{...process.env,NSTACK_LOCAL_PORT:'',PATH:join(dir,'bin')+':/usr/bin:/bin',FIXTURE_CONTAINER:join(dir,'container.json'),FIXTURE_STATE:join(dir,'state.json'),FIXTURE_ROOT:dir},stdout:'pipe',stderr:'pipe'});
 const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(exit).not.toBe(0);expect(await readFile(join(dir,'early'),'utf8')).toContain('saved');expect(await readFile(join(dir,'port'),'utf8')).toContain('3199');
 expect(out).toContain('not ready');expect(out).not.toContain(code);expect(err).toContain('Installation did not become ready');
 expect(await readFile(join(dir,'nstack-one-setup.txt'),'utf8')).toContain(code);
}));

test('durable state reader suppresses code for environment-managed administration and claims',()=>fixture(async dir=>{
 await writeFile(join(dir,'bootstrap.json'),JSON.stringify({service_npub:'npub1fixture',claim_code:code}));
 for(const kind of ['unused','managed','claimed']){
  await writeFile(join(dir,'environment'),kind==='managed'?'PATH=/bin'+String.fromCharCode(0)+'ADMIN_NPUB=npub1admin'+String.fromCharCode(0):'');
  if(kind==='claimed')await writeFile(join(dir,'claim.json'),'{}');
  const wrapper=`const original=Bun.file;Bun.file=(path)=>original(path==='/proc/1/environ'?${JSON.stringify(join(dir,'environment'))}:${JSON.stringify(dir)}+'/'+path.split('/').pop());`;
  const child=Bun.spawn([process.execPath,'-e',wrapper+recoveryReadScript],{stdout:'pipe',stderr:'pipe'});
  const out=await new Response(child.stdout).text();expect(await child.exited).toBe(0);const state=JSON.parse(out);
  expect(state.claimed).toBe(kind!=='unused');expect(state.code).toBe(kind==='unused'?code:undefined);
 }
}));
