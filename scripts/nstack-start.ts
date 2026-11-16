import {manageHostService} from './nstack-host-service';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dir,'..');const project=process.argv[2]||'nstack';
if(!/^[a-z0-9][a-z0-9_-]*$/.test(project))throw Error('Invalid installation name');
const base=Bun.spawn(['bash',join(root,'docker/ensure-bun-base.sh')],{cwd:root,stdout:'pipe',stderr:'inherit'});
const [baseCode,baseName]=await Promise.all([base.exited,new Response(base.stdout).text()]);if(baseCode!==0)throw Error('Clean Bun runtime unavailable; local installation has not been replaced');
let sha:string;
const stamp=Bun.file(join(root,'source.json'));
if(await stamp.exists()){
 const source=await stamp.json();if(!/^[a-f0-9]{40}$/.test(source.source_commit))throw Error('Invalid packaged source stamp');sha=source.source_commit;
}else{
 const commit=Bun.spawn(['git','rev-parse','HEAD'],{cwd:root,stdout:'pipe',stderr:'ignore'});sha=(await new Response(commit.stdout).text()).trim();if(await commit.exited!==0||!/^[a-f0-9]{40}$/.test(sha))throw Error('Source commit unavailable');
}
const compose=['docker','compose','-p',project,'-f',join(root,'docker-compose.setup.yml')];
const child=Bun.spawn([...compose,'up','-d','--build'],{cwd:root,stdout:'inherit',stderr:'inherit',env:{...process.env,NSTACK_BUN_IMAGE:baseName.trim(),NSTACK_BUILD_COMMIT:sha,NSTACK_BUILD_TIME:new Date().toISOString()}});
if(await child.exited!==0)throw Error('Installation did not become ready; existing volumes are preserved');
const claim=Bun.spawn([...compose,'exec','-T','tower','bun','-e',"const f=Bun.file('/run/nstack/claim.json');if(!await f.exists()){const s=await Bun.file('/run/nstack/bootstrap.json').json();console.log('Local one-time installation claim code: '+s.claim_code)}"],{stdout:'inherit',stderr:'inherit'});await claim.exited;
console.log('Open http://127.0.0.1:'+(process.env.NSTACK_LOCAL_PORT||'3101')+'/ui. Host FIPS readiness is checked independently; local administration stays available.');
console.log(JSON.stringify(await manageHostService('install',project)));
console.log('The per-installation host helper is managed by the OS user service and stays running after this terminal closes.');
