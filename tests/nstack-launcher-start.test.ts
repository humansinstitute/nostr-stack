import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

// Exercise the real launcher orchestration without starting shared services.
async function launch(fail:string){
 const dir=await mkdtemp(join(tmpdir(),'nstack-start-'));
 try{
  const docker=join(dir,'docker'),log=join(dir,'calls');
  await writeFile(docker,`#!/bin/sh\necho "$*" >> "$CALLS"\ncase "$*" in\n 'info') [ "$FAIL" != daemon ];;\n 'compose version') [ "$FAIL" != compose ];;\n 'image inspect '*) exit 0;;\n 'run --rm --entrypoint bun '*) echo 1.2.23;;\n 'pull '*) exit 1;;\n 'compose '*'build bootstrap minio') [ \"$FAIL\" != build ];;\n 'compose '*' up -d '*) exit 1;;\n *) exit 0;;\nesac\n`);await chmod(docker,0o755);
  const p=Bun.spawn([process.execPath,resolve(import.meta.dir,'../scripts/nstack-start.ts'),'retry-fixture'],{env:{...process.env,PATH:dir+':/usr/bin:/bin',CALLS:log,FAIL:fail},stdout:'pipe',stderr:'pipe'});
  const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
  return {code,text:out+err,calls:await readFile(log,'utf8')};
 }finally{await rm(dir,{recursive:true,force:true});}
}
test('unreachable Docker fails before downloads and explains same-name retry',async()=>{
 const r=await launch('daemon');expect(r.code).not.toBe(0);expect(r.calls.trim()).toBe('info');expect(r.text).toContain('Start Docker Desktop');expect(r.text).toContain('same installation name');
});
test('missing Compose fails before downloading or changing containers',async()=>{
 const r=await launch('compose');expect(r.code).not.toBe(0);expect(r.calls.trim()).toBe('info\ncompose version');expect(r.text).toContain('Compose plugin is unavailable');
});

test('failed local build never starts containers or tries pulling controller',async()=>{
 const r=await launch('build');expect(r.code).not.toBe(0);
 expect(r.calls).toContain('pull postgres');expect(r.calls).toContain('build bootstrap minio');
 expect(r.calls).not.toContain(' up ');expect(r.calls).not.toContain('pull controller');
 expect(r.text).toContain('existing volumes, credentials and identity are preserved');
});

test('readiness failure exits without printing claim or registering helper',async()=>{
 const r=await launch('ready');expect(r.code).not.toBe(0);
 const build=r.calls.indexOf('build bootstrap minio'),up=r.calls.indexOf('up -d --no-build --pull never --wait --wait-timeout 240');
 expect(build).toBeGreaterThan(0);expect(up).toBeGreaterThan(build);
 expect(r.calls).not.toContain('exec -T tower');expect(r.text).not.toContain('Open http://');expect(r.text).not.toContain('state":"registered');expect(r.text).toContain('Installation did not become ready');
});
