import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {includeBundleSource,packageLauncher} from '../scripts/package-nstack-launcher';

test('release source excludes operational state and retains Docker build inputs',()=>{
 for(const path of ['.env','.env.prod','tmp/docs/handoffs/private.md','.runtime/identity.json','.git/config','node_modules/pkg/index.js','deploy/keys/secret','deploy/foo.pem','src/secret.key'])expect(includeBundleSource(path)).toBe(false);
 for(const path of ['Dockerfile','.dockerignore','package.json','bun.lock','src/index.ts','lib/common.ts','deploy/setup-fips/prepare-macos.sh','scripts/nstack-host-bridge.ts','docker/entrypoint.sh'])expect(includeBundleSource(path)).toBe(true);
});

test('archive relocates without host Bun/Git/modules and rejects altered source/runtime',async()=>{
 const work=await mkdtemp(join(tmpdir(),'nstack-package-test-')),root=join(work,'repo'),out=join(work,'out');
 async function run(args:string[],cwd=root,env=process.env){const p=Bun.spawn(args,{cwd,env,stdout:'pipe',stderr:'pipe'});const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);return {code,out,err};}
 try{
  await mkdir(join(root,'scripts'),{recursive:true});
  await writeFile(join(root,'.gitignore'),'.env\n.runtime\nnode_modules\n');
  await writeFile(join(root,'docker-compose.setup.yml'),'services: {}\n');
  await writeFile(join(work,'LICENSE.md'),'Fixture runtime notice');
  await writeFile(join(root,'scripts/nstack-bundle-entry.ts'),await readFile(resolve(import.meta.dir,'../scripts/nstack-bundle-entry.ts')));
  for(const name of ['nstack-recovery','nstack-start','nstack-host','nstack-host-service'])await writeFile(join(root,'scripts',name+'.ts'),`console.log(JSON.stringify({script:${JSON.stringify(name)},args:process.argv.slice(2),directory:import.meta.dir}));`);
  expect((await run(['git','init','-q'])).code).toBe(0);
  await run(['git','add','.']);expect((await run(['git','-c','user.name=Package Test','-c','user.email=test@example.invalid','commit','-qm','test: package fixture'])).code).toBe(0);
  await writeFile(join(root,'.env'),'private fixture excluded');
  const runtimeSha=createHash('sha256').update(await readFile(process.execPath)).digest('hex');
  const options={root,out,runtime:process.execPath,runtimeSha,runtimeVersion:Bun.version,runtimeLicense:join(work,'LICENSE.md'),platform:`${process.platform}-${process.arch}`,provenance:'test builder executable',version:'0.1.0-test'};
  await expect(packageLauncher({...options,runtimeSha:'0'.repeat(64)})).rejects.toThrow('Runtime hash mismatch');
  await expect(packageLauncher({...options,platform:'win32-x64'})).rejects.toThrow('Unsupported platform');
  const result=await packageLauncher(options);
  await mkdir(join(work,'relocated folder'));expect((await run(['tar','-xzf',result.artifact,'-C',join(work,'relocated folder')])).code).toBe(0);
  const bundle=join(work,'relocated folder',`nstack-launcher-0.1.0-test-${options.platform}`),env={PATH:'/usr/bin:/bin',HOME:work};
  const verified=await run([join(bundle,'nstack'),'verify'],work,env);expect(verified.code).toBe(0);expect(JSON.parse(verified.out).state).toBe('verified');
  const manifest=JSON.parse(await readFile(join(bundle,'bundle.json'),'utf8'));expect(manifest.files['.env']).toBeUndefined();expect(manifest.files['.git/config']).toBeUndefined();expect(manifest.files['node_modules']).toBeUndefined();
  const launched=await run([join(bundle,'nstack'),'setup','fixture'],work,env);expect(launched.code).toBe(0);expect(JSON.parse(launched.out).args).toEqual(['fixture']);expect(JSON.parse(launched.out).directory).toBe(await realpath(join(bundle,'scripts')));
  const recovered=await run([join(bundle,'nstack'),'recovery','fixture'],work,env);expect(recovered.code).toBe(0);expect(JSON.parse(recovered.out).script).toBe('nstack-recovery');
  const verifier=await readFile(join(bundle,'scripts/nstack-bundle-entry.js'));
  await writeFile(join(bundle,'scripts/nstack-bundle-entry.js'),'console.log("must not execute")');
  const badVerifier=await run([join(bundle,'nstack'),'verify'],work,env);expect(badVerifier.code).not.toBe(0);expect(badVerifier.out).not.toContain('must not execute');
  await writeFile(join(bundle,'scripts/nstack-bundle-entry.js'),verifier);
  const manifestBytes=await readFile(join(bundle,'bundle.json'));await writeFile(join(bundle,'bundle.json'),'{}');
  expect((await run([join(bundle,'nstack'),'verify'],work,env)).code).not.toBe(0);await writeFile(join(bundle,'bundle.json'),manifestBytes);
  await writeFile(join(bundle,'docker-compose.setup.yml'),'altered');expect((await run([join(bundle,'nstack'),'verify'],work,env)).code).not.toBe(0);
  await writeFile(join(bundle,'runtime/bun'),'altered');const badRuntime=await run([join(bundle,'nstack'),'verify'],work,env);expect(badRuntime.code).not.toBe(0);expect(badRuntime.err).toContain('runtime/bun hash mismatch');
  await writeFile(join(root,'scripts/nstack-start.ts'),'dirty');await expect(packageLauncher(options)).rejects.toThrow('worktree must be clean');
 }finally{await rm(work,{recursive:true,force:true});}
},60000);
