import {mkdir,writeFile,copyFile,readFile,unlink,rename,rm} from 'node:fs/promises';
import {homedir} from 'node:os';import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {hostServiceLabel,renderHostLaunchd,renderHostSystemd} from '../src/installation/host-service';
const root=resolve(import.meta.dir,'..');
async function run(args:string[],allowMissing=false){const p=Bun.spawn(args,{stdout:'pipe',stderr:'pipe'});const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);if(code!==0&&!allowMissing)throw Error('Host service operation failed: '+args[0]+' (check OS user-service authorization)');return {code,output:out||err};}
export async function manageHostService(action:string,project='nstack'){
 const label=hostServiceLabel(project),installation=join(root,'.runtime/installations',project);let snapshot=installation;
 if(!['darwin','linux'].includes(process.platform))throw Error('Host services supported on Linux/macOS');
 const directory=process.platform==='darwin'?join(homedir(),'Library/LaunchAgents'):join(homedir(),'.config/systemd/user');
 const config=join(directory,label+(process.platform==='darwin'?'.plist':'.service'));
 const uid=process.getuid?.();if(uid===undefined)throw Error('User-service identity unavailable');
 const stop=()=>run(process.platform==='darwin'?['launchctl','bootout',`gui/${uid}/${label}`]:['systemctl','--user','stop',label+'.service'],true);
 if(action==='stop'){await stop();return {state:'stopped',project,daemon_identity:'unchanged'};}
 if(action==='status'){const result=await run(process.platform==='darwin'?['launchctl','print',`gui/${uid}/${label}`]:['systemctl','--user','is-active',label+'.service'],true);return {state:result.code===0?'registered':'not_running',project};}
 if(action==='uninstall'){
  await stop();if(process.platform==='linux')await run(['systemctl','--user','disable',label+'.service'],true);
  await unlink(config).catch(e=>{if(e.code!=='ENOENT')throw e;});if(process.platform==='linux')await run(['systemctl','--user','daemon-reload']);
  return {state:'uninstalled',project,data_retained:true,daemon_identity:'unchanged'};
 }
 if(!['install','start'].includes(action))throw Error('Supported host service actions: install, start, status, stop, uninstall');
 if(action==='install'){
  await mkdir(join(installation,'revisions'),{recursive:true,mode:0o700});
  snapshot=join(installation,'staging-'+crypto.randomUUID());
  await mkdir(join(snapshot,'scripts'),{recursive:true,mode:0o700});await mkdir(join(snapshot,'deploy/setup-fips'),{recursive:true,mode:0o700});await mkdir(directory,{recursive:true,mode:0o700});
  const built=await Bun.build({entrypoints:[join(root,'scripts/nstack-host.ts')],target:'bun',outdir:join(snapshot,'scripts'),naming:'nstack-host.js'});if(!built.success)throw Error('Host runner build failed');
  const files=['docker-compose.setup.yml',...['prepare-linux.sh','prepare-macos.sh','configure-linux.sh','configure-macos.sh'].map(n=>'deploy/setup-fips/'+n)];
  for(const file of files)await copyFile(join(root,file),join(snapshot,file));
  const hashes:Record<string,string>={};for(const file of [...files,'scripts/nstack-host.js'])hashes[file]=createHash('sha256').update(await readFile(join(snapshot,file))).digest('hex');
  const manifest=JSON.stringify({version:1,project,files:hashes});
  await writeFile(join(snapshot,'manifest.json'),manifest,{mode:0o600});
  const immutable=join(installation,'revisions',createHash('sha256').update(manifest).digest('hex'));
  try{await rename(snapshot,immutable);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOTEMPTY'&&(e as NodeJS.ErrnoException).code!=='EEXIST')throw e;await rm(snapshot,{recursive:true,force:true});}
  snapshot=immutable;
  const docker=Bun.which('docker');if(!docker)throw Error('Docker CLI unavailable');
  await writeFile(config,process.platform==='darwin'?renderHostLaunchd(project,process.execPath,snapshot,dirname(docker)):renderHostSystemd(project,process.execPath,snapshot,dirname(docker)),{mode:0o600});
 }
 await stop();
 if(process.platform==='darwin'){await run(['plutil','-lint',config]);await run(['launchctl','bootstrap',`gui/${uid}`,config]);}
 else{await run(['systemctl','--user','daemon-reload']);await run(['systemctl','--user','enable','--now',label+'.service']);}
 return {state:'registered',project,snapshot,persistence:'user_login_and_restart',boot_before_login:process.platform==='linux'?'requires_operator_linger_policy':'user_login',daemon_identity:'unchanged'};
}
if(import.meta.main)console.log(JSON.stringify(await manageHostService(process.argv[2]||'status',process.argv[3]||'nstack'),null,2));
