import {readFile,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

const root=resolve(import.meta.dir,'..');
const manifest=JSON.parse(await readFile(join(root,'bundle.json'),'utf8'));
if(manifest.format!==1||manifest.platform!==`${process.platform}-${process.arch}`||!/^[a-f0-9]{40}$/.test(manifest.source_commit))throw Error('Unsupported bundle platform/source');
for(const path of ['runtime/bun','source.json','docker-compose.setup.yml','scripts/nstack-start.js','scripts/nstack-host.js','scripts/nstack-host-service.js'])if(!manifest.files?.[path])throw Error('Incomplete bundle manifest');
for(const [path,hash] of Object.entries(manifest.files) as [string,string][]){
 if(path.startsWith('/')||path.split('/').some(p=>!p||p==='.'||p==='..')||!/^[a-f0-9]{64}$/.test(hash))throw Error('Invalid bundle manifest');
 const file=join(root,path);
 if(!(await lstat(file)).isFile()||createHash('sha256').update(await readFile(file)).digest('hex')!==hash)throw Error('Bundle integrity failed: '+path);
}
if(Bun.version!==manifest.runtime.version)throw Error('Bundled runtime version mismatch');
if(JSON.parse(await readFile(join(root,'source.json'),'utf8')).source_commit!==manifest.source_commit)throw Error('Bundle source stamp mismatch');
const [command='setup',...args]=process.argv.slice(2);
if(command==='verify'){console.log(JSON.stringify({state:'verified',...manifest,files:Object.keys(manifest.files).length}));}
else {
 const entry=command==='setup'?'nstack-start.js':command==='host'?'nstack-host.js':command==='service'?'nstack-host-service.js':null;
 if(!entry)throw Error('Usage: ./nstack [setup [project] | host status | service <action> <project> | verify]');
 const child=Bun.spawn([process.execPath,join(root,'scripts',entry),...args],{cwd:root,stdin:'inherit',stdout:'inherit',stderr:'inherit'});
 process.exit(await child.exited);
}
