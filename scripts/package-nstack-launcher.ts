import {mkdir,readFile,writeFile,copyFile,chmod,readdir,lstat,mkdtemp,rm,symlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';

const sha=(data:Uint8Array|string)=>createHash('sha256').update(data).digest('hex');
export function includeBundleSource(path:string){
 if(path.split('/').some(p=>p.startsWith('.')&&p!=='.dockerignore'||['node_modules','tmp','data','logs','keys'].includes(p))||/\.(pem|key|p8|sqlite|db|log)$/.test(path))return false;
 return ['Dockerfile','package.json','bun.lock','docker-compose.setup.yml','LICENSE','.dockerignore','README.md','docs/nstack-setup.md','docs/nstack-launcher.md'].includes(path)||/^(src|lib|scripts|docker|deploy)\//.test(path);
}
async function run(args:string[],cwd:string){
 const p=Bun.spawn(args,{cwd,stdout:'pipe',stderr:'pipe'});const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
 if(code!==0)throw Error(`${args[0]} failed: ${err}`);return out.trim();
}
export async function packageLauncher(options:{root:string;out:string;runtime:string;runtimeSha:string;runtimeVersion:string;runtimeLicense:string;platform:string;provenance:string;version:string}){
 const {root,out,runtime,runtimeSha,runtimeVersion,runtimeLicense,platform,provenance,version}=options;
 if(!['darwin-arm64','linux-arm64'].includes(platform))throw Error('Unsupported platform; only verified arm64 runtimes are packaged');
 if(!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(version)||!/^\d+\.\d+\.\d+$/.test(runtimeVersion)||!/^[a-f0-9]{64}$/.test(runtimeSha)||!provenance.trim())throw Error('Explicit version, runtime SHA256 and provenance required');
 const runtimeBytes=await readFile(runtime);
 if(sha(runtimeBytes)!==runtimeSha)throw Error('Runtime hash mismatch');
 const macho=runtimeBytes.readUInt32LE(0)===0xfeedfacf&&runtimeBytes.readUInt32LE(4)===0x100000c;
 const elf=runtimeBytes.subarray(0,4).equals(Buffer.from([0x7f,69,76,70]))&&runtimeBytes[4]===2&&runtimeBytes[5]===1&&runtimeBytes.readUInt16LE(18)===183;
 if(!(platform==='darwin-arm64'?macho:elf))throw Error('Runtime binary platform mismatch');
 const commit=await run(['git','rev-parse','HEAD'],root);
 if(!/^[a-f0-9]{40}$/.test(commit))throw Error('Invalid source commit');
 const status=await run(['git','status','--porcelain','--untracked-files=all'],root);
 if(status)throw Error('Commit source changes before packaging; worktree must be clean');
 const paths=(await run(['git','ls-tree','-r','--name-only',commit],root)).split('\n').filter(includeBundleSource);
 const name=`nstack-launcher-${version}-${platform}`,work=await mkdtemp(join(tmpdir(),'nstack-package-'));
 const destination=join(work,name);
 try{
  await mkdir(destination,{recursive:true});await mkdir(out,{recursive:true});
  const archive=Bun.spawn(['git','archive','--format=tar',commit,...paths],{cwd:root,stdout:'pipe',stderr:'inherit'});
  const extract=Bun.spawn(['tar','-xf','-','-C',destination],{stdin:archive.stdout,stdout:'ignore',stderr:'inherit'});
  if((await Promise.all([archive.exited,extract.exited])).some(c=>c!==0))throw Error('Clean source archive failed');
  const meta=JSON.stringify({source_commit:commit,version},null,2)+'\n';await writeFile(join(destination,'source.json'),meta);
  // Build from committed source with the builder's installed locked dependencies.
  // The temporary dependency link is removed before manifest/archive creation.
  await symlink(join(root,'node_modules'),join(destination,'node_modules'));
  const bundledDependencies=new Set<string>();
  for(const entry of ['nstack-start','nstack-host','nstack-host-service','nstack-bundle-entry']){
   const result=await Bun.build({entrypoints:[join(destination,'scripts',entry+'.ts')],target:'bun',outdir:join(destination,'scripts'),naming:entry+'.js',packages:'bundle'});
   if(!result.success)throw Error('Host bundle build failed: '+result.logs.join('\n'));
   for(const output of result.outputs)for(const match of (await output.text()).matchAll(/^\/\/ .*?node_modules\/((?:@[^/]+\/)?[^/]+)\//gm))bundledDependencies.add(match[1]!);
  }
  await rm(join(destination,'node_modules'));
  // Retain notices for packages actually present in the unminified build outputs.
  const notices:string[]=[];
  async function dependencyNotices(name:string){
   const directory=join(root,'node_modules',name),file=Bun.file(join(directory,'package.json'));
   if(!await file.exists())throw Error('Missing dependency notice: '+name);
   const pkg=await file.json();let found=false;
   for(const entry of await readdir(directory))if(/^(license|copying|notice)(\.|$)/i.test(entry)&&(await lstat(join(directory,entry))).isFile()){
    notices.push(`## ${name}@${pkg.version}: ${entry}\n\n${await readFile(join(directory,entry),'utf8')}`);found=true;
   }
   if(!found)throw Error('Dependency license missing: '+name);
  }
  for(const name of [...bundledDependencies].sort())await dependencyNotices(name);
  await writeFile(join(destination,'HOST-DEPENDENCY-NOTICES.md'),notices.join('\n\n'));
  await mkdir(join(destination,'runtime'));await copyFile(runtime,join(destination,'runtime/bun'));await chmod(join(destination,'runtime/bun'),0o755);
  const license=await readFile(runtimeLicense);if(!license.length)throw Error('Runtime license notices required');await writeFile(join(destination,'runtime/LICENSE.md'),license);
  const [os,arch]=platform.split('-');
  const shell=`#!/bin/sh\nset -eu\nhere=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n[ "$(uname -s)" = "${os==='darwin'?'Darwin':'Linux'}" ] && [ "$(uname -m)" = "${arch==='arm64'?'aarch64':'unsupported'}" ${os==='darwin'?' -o "$(uname -m)" = "arm64"':''} ] || { echo 'Unsupported bundle platform' >&2; exit 1; }\nif command -v shasum >/dev/null 2>&1; then\n actual=$(shasum -a 256 "$here/runtime/bun"); actual=\${actual%% *}\nelif command -v sha256sum >/dev/null 2>&1; then\n actual=$(sha256sum "$here/runtime/bun"); actual=\${actual%% *}\nelse echo 'OS SHA256 tool unavailable' >&2; exit 1; fi\n[ "$actual" = "${runtimeSha}" ] || { echo 'Bundled runtime hash mismatch' >&2; exit 1; }\nexec "$here/runtime/bun" "$here/scripts/nstack-bundle-entry.js" "$@"\n`;
  await writeFile(join(destination,'nstack'),shell,{mode:0o755});
  const files:Record<string,string>={};
  async function walk(directory:string){for(const name of (await readdir(directory)).sort()){
   const path=join(directory,name),stat=await lstat(path);if(stat.isSymbolicLink())throw Error('Symlink in source archive: '+path);
   if(stat.isDirectory())await walk(path);else if(stat.isFile())files[path.slice(destination.length+1)]=sha(await readFile(path));else throw Error('Non-file archive entry');
  }}await walk(destination);
  await writeFile(join(destination,'bundle.json'),JSON.stringify({format:1,version,platform,source_commit:commit,signature_status:'unsigned archive; no release signature or notarization',runtime:{version:runtimeVersion,sha256:runtimeSha,provenance},files},null,2)+'\n');
  const artifact=join(out,name+'.tar.gz');if(await Bun.file(artifact).exists())throw Error('Artifact already exists; choose a new version/output directory');
  await run(['tar','-czf',artifact,'-C',work,name],root);
  const digest=sha(await readFile(artifact));await writeFile(artifact+'.sha256',digest+'  '+name+'.tar.gz\n');
  return {artifact,sha256:digest,bytes:(await lstat(artifact)).size,source_commit:commit,platform,runtime_sha256:runtimeSha};
 }finally{await rm(work,{recursive:true,force:true});}
}
if(import.meta.main){
 const args=process.argv.slice(2);const get=(flag:string)=>{const i=args.indexOf(flag);if(i<0||!args[i+1])throw Error('Required '+flag);return args[i+1]!;};
 console.log(JSON.stringify(await packageLauncher({root:resolve(import.meta.dir,'..'),out:resolve(get('--out')),runtime:resolve(get('--runtime')),runtimeSha:get('--runtime-sha256'),runtimeVersion:get('--runtime-version'),runtimeLicense:resolve(get('--runtime-license')),platform:get('--platform'),provenance:get('--runtime-provenance'),version:get('--version')}),null,2));
}
