import {recoverInstallation,installationContainer,localPort} from './nstack-recovery';
import {manageHostService} from './nstack-host-service';
import {
  detectSetupProjectStorageProvider,
  parseSetupStorageProviderFile,
  SETUP_STORAGE_PROVIDER_FILE,
  type SetupStorageProviderRecord,
} from '../src/installation/setup-storage-provider';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dir,'..');const project=process.argv[2]||'nstack';
if(!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project))throw Error('Invalid installation name');
async function dockerOut(args:string[]):Promise<{code:number;out:string;err:string}>{
 const child=Bun.spawn(['docker',...args],{stdout:'pipe',stderr:'pipe'});
 const timer=setTimeout(()=>child.kill(),15000);
 try{
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  return {code,out:out.trim(),err:err.trim()};
 }finally{clearTimeout(timer);}
}
async function checkDocker(){
 if(!Bun.which('docker'))throw Error('Docker with Compose is required. Install Docker Desktop on macOS, or Docker Engine with the Compose plugin on Linux, then retry the same installation name.');
 const info=await dockerOut(['info']);
 if(info.code!==0)throw Error('Docker is not running or is unreachable. Start Docker Desktop on macOS, or the Docker Engine service on Linux, and check your Docker context/socket access. Then retry the same installation name; existing data is preserved.\n'+info.err);
 const compose=await dockerOut(['compose','version']);
 if(compose.code!==0)throw Error('Docker Compose plugin is unavailable. Install/enable Compose, then retry the same installation name.');
}
function extractTarFile(tar:Buffer,filename:string):string|null{
 for(let offset=0;offset+512<=tar.length;){
  const header=tar.subarray(offset,offset+512),size=parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,'').trim(),8);
  if(!Number.isFinite(size)||size<0)break;
  const name=header.subarray(0,100).toString().replace(/\0.*$/s,'');
  if(name.split('/').at(-1)===filename)return tar.subarray(offset+512,offset+512+size).toString('utf8');
  offset+=512+Math.ceil(size/512)*512;
 }
 return null;
}
async function inspectProjectProvider(previous:any){
 const volsRes=await dockerOut(['volume','ls','--filter',`label=com.docker.compose.project=${project}`,'--format','{{.Name}}']);
 if(volsRes.code!==0)throw Error('Cannot inspect existing installation volumes. Retry with the same installation name.');
 const names=volsRes.out?volsRes.out.split('\n').filter(Boolean):[];
 let hasBootstrapVolume=false,hasMinioStorageVolume=false,hasSeaweedfsStorageVolume=false;
 let bootstrapVolumeName:string|null=null;
 if(names.length){
  const insp=await dockerOut(['volume','inspect',...names]);
  if(insp.code!==0)throw Error('Cannot inspect existing installation volume metadata. Retry with the same installation name.');
  const list=JSON.parse(insp.out) as Array<{Name:string;Labels?:Record<string,string>}>;
  for(const v of list){
   const key=v.Labels?.['com.docker.compose.volume'];
   if(key==='bootstrap'){hasBootstrapVolume=true;bootstrapVolumeName=v.Name;}
   if(key==='storage')hasMinioStorageVolume=true;
   if(key==='storage-seaweedfs')hasSeaweedfsStorageVolume=true;
  }
 }
 let providerFile:SetupStorageProviderRecord|null=null;
 if(previous?.Id){
  const cp=Bun.spawn(['docker','cp',`${previous.Id}:/run/nstack/${SETUP_STORAGE_PROVIDER_FILE}`,'-'],{stdout:'pipe',stderr:'pipe'});
  const [code,buf,errText]=await Promise.all([cp.exited,new Response(cp.stdout).arrayBuffer(),new Response(cp.stderr).text()]);
  if(code===0){
   const text=extractTarFile(Buffer.from(buf),SETUP_STORAGE_PROVIDER_FILE);
   if(text===null)throw Error(`Failed to extract ${SETUP_STORAGE_PROVIDER_FILE} from container ${previous.Id}; refusing to guess storage provider.`);
   providerFile=parseSetupStorageProviderFile(text);
  }else if(!/Could not find the file|No such container:path|no such file/i.test(errText)){
   throw Error(`Failed to inspect ${SETUP_STORAGE_PROVIDER_FILE} from container ${previous.Id}: ${errText.trim()||'exit '+code}`);
  }
 }else if(bootstrapVolumeName){
  // Ensure postgres:16-alpine is locally present before reading the durable bootstrap volume.
  const imgCheck=await dockerOut(['image','inspect','postgres:16-alpine']);
  if(imgCheck.code!==0){
   const pull=Bun.spawn(['docker','pull','postgres:16-alpine'],{stdout:'inherit',stderr:'inherit'});
   if(await pull.exited!==0)throw Error('Cannot pull postgres:16-alpine to inspect existing installation storage provider. Check network/registry availability and retry.');
  }
  const read=await dockerOut(['run','--rm','--network','none','-v',`${bootstrapVolumeName}:/run/nstack:ro`,'postgres:16-alpine','sh','-c',`if [ ! -e /run/nstack/${SETUP_STORAGE_PROVIDER_FILE} ]; then printf '__NSTACK_MISSING__'; else cat /run/nstack/${SETUP_STORAGE_PROVIDER_FILE}; fi`]);
  if(read.code!==0){
   throw Error(`Cannot read ${SETUP_STORAGE_PROVIDER_FILE} from durable bootstrap volume ${bootstrapVolumeName}: ${read.err||'exit '+read.code}`);
  }
  if(read.out!=='__NSTACK_MISSING__'){
   providerFile=parseSetupStorageProviderFile(read.out);
  }
 }
 return detectSetupProjectStorageProvider({
  hasBootstrapVolume,
  hasMinioStorageVolume,
  hasSeaweedfsStorageVolume,
  providerFile,
  requestedProvider:process.env.NSTACK_SETUP_STORAGE_PROVIDER,
 });
}
await checkDocker();
const previous=await installationContainer(project);
const previousPort=localPort(previous);
if(previousPort&&!process.env.NSTACK_LOCAL_PORT)process.env.NSTACK_LOCAL_PORT=previousPort;
const storageProvider=await inspectProjectProvider(previous);
const base=Bun.spawn(['bash',join(root,'docker/ensure-bun-base.sh')],{cwd:root,stdout:'pipe',stderr:'inherit'});
const [baseCode,baseName]=await Promise.all([base.exited,new Response(base.stdout).text()]);if(baseCode!==0)throw Error('Clean Bun runtime unavailable; retry the same installation name. Existing data is preserved.');
let sha:string;
const stamp=Bun.file(join(root,'source.json'));
if(await stamp.exists()){
 const source=await stamp.json();if(!/^[a-f0-9]{40}$/.test(source.source_commit))throw Error('Invalid packaged source stamp');sha=source.source_commit;
}else{
 const commit=Bun.spawn(['git','rev-parse','HEAD'],{cwd:root,stdout:'pipe',stderr:'ignore'});sha=(await new Response(commit.stdout).text()).trim();if(await commit.exited!==0||!/^[a-f0-9]{40}$/.test(sha))throw Error('Source commit unavailable');
}
const composeProfiles=storageProvider==='external-s3'?'':storageProvider;
const compose=['docker','compose','-p',project,'-f',join(root,'docker-compose.setup.yml')];
const env={
 ...process.env,
 COMPOSE_PROFILES:composeProfiles,
 NSTACK_SETUP_STORAGE_PROVIDER:storageProvider,
 NSTACK_BUN_IMAGE:baseName.trim(),
 NSTACK_BUILD_COMMIT:sha,
 NSTACK_BUILD_TIME:new Date().toISOString(),
};
async function step(args:string[],failure:string){
 const child=Bun.spawn([...compose,...args],{cwd:root,stdout:'inherit',stderr:'inherit',env});
 if(await child.exited!==0)throw Error(failure+' Retry with the same installation name; existing volumes, credentials and identity are preserved.');
}
// Fetch only external runtime images. Build every local image before any service
// can use it (controller and storage-init/seaweedfs-init share the built image).
if(storageProvider==='seaweedfs'){
 await step(['pull','postgres','seaweedfs'],'Postgres or SeaweedFS image download failed. Check network/registry availability.');
 await step(['build','bootstrap'],'Local image build failed. Check the build output for the exact unavailable dependency.');
}else if(storageProvider==='minio'){
 await step(['pull','postgres'],'Postgres download failed. Check network/registry availability.');
 await step(['build','bootstrap','minio'],'Local image build failed. Check the build output for the exact unavailable dependency.');
}else{
 await step(['pull','postgres'],'Postgres download failed. Check network/registry availability.');
 await step(['build','bootstrap'],'Local image build failed. Check the build output for the exact unavailable dependency.');
}
// Save while Compose waits, as soon as the durable state is readable. The
// final refresh happens before helper registration or success output.
const starting=Bun.spawn([...compose,'up','-d','--no-build','--pull','never','--wait','--wait-timeout','240'],{cwd:root,stdout:'inherit',stderr:'inherit',env});
let finished=false;const completion=starting.exited.then(code=>{finished=true;return code;});
let saved=false;
while(!finished){
 if(!saved)try{await recoverInstallation(root,project,true);saved=true;}catch{/* Startup may not yet have created/readied Tower. Final read below is mandatory. */}
 if(!finished)await Promise.race([completion,Bun.sleep(500)]);
}
const startCode=await completion;
if(startCode!==0){
 try{await recoverInstallation(root,project);}catch{console.error('Recovery not yet available. Startup was interrupted or did not become ready.');}
 throw Error('Installation did not become ready. Rerun setup or recovery with the same installation name; existing volumes, credentials and identity are preserved.');
}
await recoverInstallation(root,project);
console.log(JSON.stringify(await manageHostService('install',project)));
console.log('The per-installation host helper is managed by the OS user service and stays running after this terminal closes.');
