import {manageHostService} from './nstack-host-service';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dir,'..');const project=process.argv[2]||'nstack';
if(!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project))throw Error('Invalid installation name');
async function checkDocker(){
 if(!Bun.which('docker'))throw Error('Docker with Compose is required. Install Docker Desktop on macOS, or Docker Engine with the Compose plugin on Linux, then retry the same installation name.');
 const info=Bun.spawn(['docker','info'],{stdout:'ignore',stderr:'pipe'});
 const timer=setTimeout(()=>info.kill(),15000);
 const [code,detail]=await Promise.all([info.exited,new Response(info.stderr).text()]);clearTimeout(timer);
 if(code!==0)throw Error('Docker is not running or is unreachable. Start Docker Desktop on macOS, or the Docker Engine service on Linux, and check your Docker context/socket access. Then retry the same installation name; existing data is preserved.\n'+detail.trim());
 const compose=Bun.spawn(['docker','compose','version'],{stdout:'ignore',stderr:'ignore'});
 if(await compose.exited!==0)throw Error('Docker Compose plugin is unavailable. Install/enable Compose, then retry the same installation name.');
}
await checkDocker();
const base=Bun.spawn(['bash',join(root,'docker/ensure-bun-base.sh')],{cwd:root,stdout:'pipe',stderr:'inherit'});
const [baseCode,baseName]=await Promise.all([base.exited,new Response(base.stdout).text()]);if(baseCode!==0)throw Error('Clean Bun runtime unavailable; retry the same installation name. Existing data is preserved.');
let sha:string;
const stamp=Bun.file(join(root,'source.json'));
if(await stamp.exists()){
 const source=await stamp.json();if(!/^[a-f0-9]{40}$/.test(source.source_commit))throw Error('Invalid packaged source stamp');sha=source.source_commit;
}else{
 const commit=Bun.spawn(['git','rev-parse','HEAD'],{cwd:root,stdout:'pipe',stderr:'ignore'});sha=(await new Response(commit.stdout).text()).trim();if(await commit.exited!==0||!/^[a-f0-9]{40}$/.test(sha))throw Error('Source commit unavailable');
}
const compose=['docker','compose','-p',project,'-f',join(root,'docker-compose.setup.yml')];
const env={...process.env,NSTACK_BUN_IMAGE:baseName.trim(),NSTACK_BUILD_COMMIT:sha,NSTACK_BUILD_TIME:new Date().toISOString()};
async function step(args:string[],failure:string){
 const child=Bun.spawn([...compose,...args],{cwd:root,stdout:'inherit',stderr:'inherit',env});
 if(await child.exited!==0)throw Error(failure+' Retry with the same installation name; existing volumes, credentials and identity are preserved.');
}
// Fetch only external runtime images. Build every local image before any service
// can use it (controller and storage-init deliberately share the built images).
await step(['pull','postgres'],'Postgres download failed. Check network/registry availability.');
await step(['build','bootstrap','minio'],'Local image build failed. Check the build output for the exact unavailable dependency.');
await step(['up','-d','--no-build','--pull','never','--wait','--wait-timeout','240'],'Installation did not become ready.');
await step(['exec','-T','tower','bun','-e',"const f=Bun.file('/run/nstack/claim.json');if(!await f.exists()){const s=await Bun.file('/run/nstack/bootstrap.json').json();console.log('Local one-time installation claim code: '+s.claim_code)}"],'Installation claim read failed.');
console.log('Open http://127.0.0.1:'+(process.env.NSTACK_LOCAL_PORT||'3101')+'/ui. Host FIPS readiness is checked independently; local administration stays available.');
console.log(JSON.stringify(await manageHostService('install',project)));
console.log('The per-installation host helper is managed by the OS user service and stays running after this terminal closes.');
