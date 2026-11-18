import {constants} from 'node:fs';
import {lstat,open,rename,unlink,realpath,link} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';

export const recoveryReadScript=`const s=await Bun.file('/run/nstack/bootstrap.json').json();const environment=await Bun.file('/proc/1/environ').text();const managed=environment.split(String.fromCharCode(0)).some(v=>v.startsWith('ADMIN_NPUB=')&&v.length>'ADMIN_NPUB='.length);const claimed=managed||await Bun.file('/run/nstack/claim.json').exists();console.log(JSON.stringify({service_npub:s.service_npub,claimed,code:claimed?undefined:s.claim_code}));`;

export function validateProject(project:string){
 if(!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project))throw Error('Invalid installation name');
}
async function docker(args:string[]){
 const child=Bun.spawn(['docker',...args],{stdout:'pipe',stderr:'pipe'});
 const timer=setTimeout(()=>child.kill(),15000);
 try{
  const [code,out]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  if(code!==0)throw Error('Cannot read installation from Docker. Check Docker is running and retry recovery; no installation state was changed.');
  return out.trim();
 }finally{clearTimeout(timer);}
}
export async function installationContainer(project:string){
 validateProject(project);
 const ids=(await docker(['ps','-a','--filter',`label=com.docker.compose.project=${project}`,'--filter','label=com.docker.compose.service=tower','--format','{{.ID}}'])).split('\n').filter(Boolean);
 if(!ids.length)return null;
 if(ids.length!==1)throw Error('Ambiguous installation containers; refusing recovery.');
 const [container]=JSON.parse(await docker(['inspect',ids[0]!]));
 if(container.Config?.Labels?.['com.docker.compose.project']!==project||container.Config?.Labels?.['com.docker.compose.service']!=='tower')throw Error('Installation labels changed; retry recovery.');
 return container;
}
export function localPort(container:any):string|null{
 const ports=container?.NetworkSettings?.Ports?.['3100/tcp']||container?.HostConfig?.PortBindings?.['3100/tcp'];
 const binding=ports?.find((p:any)=>p.HostIp==='127.0.0.1');
 return binding&&/^\d+$/.test(binding.HostPort)&&Number(binding.HostPort)>0&&Number(binding.HostPort)<=65535?binding.HostPort:null;
}
export async function saveRecovery(root:string,project:string,installation:string,url:string,claimed:boolean,code:string|undefined,ready:boolean,binding?:{daemon:string;volume:string;created:string}){
 validateProject(project);
 root=resolve(root);
 if(await realpath(root)!==root)throw Error('Recovery install folder must not use symlinks.');
 const marker=`NStack recovery v1 ${project} ${installation}`;
 const path=join(root,`nstack-${project}-setup.txt`);
 async function existing(){
  try{
   const stat=await lstat(path);
   if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.())throw Error('Unsafe recovery file; refusing overwrite.');
   const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{
    const opened=await file.stat();if(opened.ino!==stat.ino||opened.dev!==stat.dev)throw Error('Recovery file changed; retry.');
    if((await file.readFile('utf8')).split('\n')[0]!==marker)throw Error('Recovery file belongs to another installation; refusing overwrite.');
   }finally{await file.close();}
   return stat;
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
 }
 const before=await existing();
 const temporary=join(root,`.nstack-recovery-${randomBytes(16).toString('hex')}.tmp`);
 const contents=[marker,...(binding?['Docker binding v1 '+JSON.stringify(binding)]:[]),`Setup URL: ${url}`,`Readiness: ${ready?'ready at last check':'not ready; startup may still be in progress'}`,claimed?'Administrator: already claimed or managed by environment settings. Sign in with the existing administrator Nostr identity.':`Unused first-administrator claim code: ${code}`,'','This code can claim administration once only. A copied code cannot be reused after claim.','This file is refreshed by setup/recovery, not automatically when a claim occurs.','Keep this private. Recovery never resets administration or installation identity.',''].join('\n');
 const file=await open(temporary,'wx',0o600);
 try{
  await file.writeFile(contents);await file.sync();await file.close();
  const current=await existing();
  if(current?.ino!==before?.ino||current?.dev!==before?.dev)throw Error('Recovery file changed; retry.');
  if(before)await rename(temporary,path);else await link(temporary,path);
  const directory=await open(root,'r');try{await directory.sync();}finally{await directory.close();}
 }finally{await file.close().catch(()=>{});await unlink(temporary).catch(()=>{});}
 return path;
}
export async function recoverInstallation(root:string,project:string,quiet=false){
 const container=await installationContainer(project);
 if(!container?.State?.Running)throw Error(`Installation ${project} is not running or startup was interrupted. Rerun setup with the same name; existing volumes and identity are preserved. Recovery does not start or rebuild services.`);
 const port=localPort(container);if(!port)throw Error('No known loopback setup port; refusing to print a default URL.');
 const mount=container.Mounts?.find((m:any)=>m.Destination==='/run/nstack'&&m.Type==='volume');
 if(!mount?.Name)throw Error('Durable installation volume unavailable; refusing recovery.');
 // Read only the needed public identity/code/claim status, never runtime credentials.
 // Any existing claim file suppresses the code, even if ownership state is damaged.
 const state=JSON.parse(await docker(['exec',container.Id,'bun','-e',recoveryReadScript]));
 if(typeof state.service_npub!=='string'||!/^npub1[a-z0-9]+$/.test(state.service_npub)||(!state.claimed&&!/^[a-f0-9]{48}$/.test(state.code)))throw Error('Installation state unavailable; retry the same project after startup.');
 const url=`http://127.0.0.1:${port}/ui`;
 const ready=container.State.Health?.Status==='healthy';
 const identity=state.service_npub;
 const daemon=await docker(['info','--format','{{.ID}}']);
 const [volume]=JSON.parse(await docker(['volume','inspect',mount.Name]));
 if(!daemon||volume?.Name!==mount.Name||volume.Labels?.['com.docker.compose.project']!==project||volume.Labels?.['com.docker.compose.volume']!=='bootstrap'||typeof volume.CreatedAt!=='string')throw Error('Cannot bind recovery to durable installation volume.');
 const path=await saveRecovery(root,project,identity,url,state.claimed,state.code,ready,{daemon,volume:mount.Name,created:volume.CreatedAt});
 if(!quiet){console.log(`Recovery file: ${path}\nSetup URL: ${url}\n${ready?'Installation ready.':'Installation not ready yet; rerun recovery after startup or setup with the same name.'}\n${state.claimed?'Administrator already claimed or managed; use the existing administrator identity.':'The unused one-time administrator claim code is in the private recovery file.'}`);}
 return {path,url,ready,claimed:state.claimed};
}
if(import.meta.main)await recoverInstallation(resolve(import.meta.dir,'..'),process.argv[2]||'nstack');
