import {inspectHostFips,serveInstallationFips,installationFipsRoutes,hostInstallationCompletion} from '../src/installation/host-fips';
import {resolve,join} from 'node:path';
import {mkdir,copyFile,writeFile} from 'node:fs/promises';
const root=resolve(import.meta.dir,'..');const command=process.argv[2]||'status';
if(command==='status')console.log(JSON.stringify(await inspectHostFips(),null,2));
else if(command==='install'){
 const status=await inspectHostFips();
 if(status.state==='ready'){console.log(JSON.stringify({...status,reused_existing_daemon:true}));process.exit(0);}
 if(status.state==='not_ready')throw Error('Existing daemon needs operator repair; refusing to overwrite identity or configuration.');
 const state=join(root,'.runtime/setup-fips');await mkdir(state,{recursive:true,mode:0o700});
 if(process.platform==='darwin'){
  const pkg=join(state,'fips.pkg');const prepare=Bun.spawn(['bash',join(root,'deploy/setup-fips/prepare-macos.sh'),pkg],{stdout:'inherit',stderr:'inherit'});
  if(await prepare.exited!==0)throw Error('Package preparation failed');
  const quote=(value:string)=>"'"+value.replaceAll("'",String.fromCharCode(39,92,39,39))+"'";
  const command='/usr/sbin/installer -pkg '+quote(pkg)+' -target / && /bin/sh '+quote(join(root,'deploy/setup-fips/configure-macos.sh'));
  const installer=Bun.spawn(['osascript','-e','do shell script '+JSON.stringify(command)+' with administrator privileges'],{stdout:'inherit',stderr:'inherit'});
  if(await installer.exited!==0)throw Error('OS installation/authorization did not complete');
  console.log(JSON.stringify(await inspectHostFips()));
 }else if(process.platform==='linux'){
  const bundle=join(state,'linux');const prepare=Bun.spawn(['bash',join(root,'deploy/setup-fips/prepare-linux.sh'),bundle],{stdout:'inherit',stderr:'inherit'});
  if(await prepare.exited!==0)throw Error('Package preparation failed');
  await copyFile(join(root,'deploy/setup-fips/configure-linux.sh'),join(bundle,'configure-linux.sh'));
  const installerPath=join(bundle,'install-nstack.sh');
  await writeFile(installerPath,'#!/bin/bash\nset -eu\nhere="$(cd "$(dirname "$0")" && pwd)"\n/bin/bash "$here/install.sh"\n/bin/sh "$here/configure-linux.sh"\n',{mode:0o700});
  const installer=Bun.spawn(['pkexec','/bin/bash',installerPath],{stdout:'inherit',stderr:'inherit'});
  if(await installer.exited!==0)throw Error('OS installation/authorization did not complete');
  console.log(JSON.stringify(await inspectHostFips()));
 }else throw Error('Supported host platforms: Linux and macOS');
 }else if(command==='supervise'){
 const project=process.argv[3]||'nstack';if(!/^[a-z0-9][a-z0-9_-]*$/.test(project))throw Error('Invalid Compose project');
 const bridge=async(mode:string,body?:unknown)=>{
  const child=Bun.spawn(['docker','compose','-p',project,'-f',join(root,'docker-compose.setup.yml'),'exec','-T','tower','bun','scripts/nstack-host-bridge.ts',mode],{stdin:body===undefined?'ignore':'pipe',stdout:'pipe',stderr:'pipe'});
  if(body!==undefined){child.stdin.write(JSON.stringify(body));child.stdin.end();}
  const [code,out]=await Promise.all([child.exited,new Response(child.stdout).text()]);if(code!==0)throw Error('Installation bridge unavailable');return mode==='read'?JSON.parse(out):null;
 };
 let active:Awaited<ReturnType<typeof serveInstallationFips>>|null=null;let activeKey='';
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{active?.stop();process.exit(0);});
 while(true){
  try{
   const {settings,operation}=await bridge('read');let status=await inspectHostFips();
   let nextOperation=operation;
   if(operation){
    if(operation.state==='awaiting_os_authorization')nextOperation={...operation,state:status.state==='ready'?'complete':'awaiting_os_authorization'};
    else if(operation.state==='running')nextOperation={...operation,state:status.state==='ready'?'complete':'recheck_required'};
    else if(status.state==='ready')nextOperation={...operation,state:'complete'};
    else{
     await bridge('write',{status:{...status,observed_at:Date.now()},operation:{...operation,state:'running'}});
     // Installation is launched only from an administrator-signed explicit UI operation.
     const installer=Bun.spawn([process.execPath,import.meta.path,'install'],{stdout:'inherit',stderr:'inherit'});
     let heartbeatBusy=false;let heartbeatWork:Promise<unknown>=Promise.resolve();
     const heartbeat=setInterval(()=>{if(!heartbeatBusy){heartbeatBusy=true;heartbeatWork=bridge('write',{status:{...status,observed_at:Date.now(),requirement:'Complete the host OS authorization dialog.'},operation:{...operation,state:'running'}}).catch(()=>{}).finally(()=>{heartbeatBusy=false;});}},3000);
     const code=await installer.exited;clearInterval(heartbeat);await heartbeatWork;
     status=await inspectHostFips();nextOperation={...operation,state:hostInstallationCompletion(code,status)};
    }
   }
   const routes=installationFipsRoutes(settings,status);
   const key=JSON.stringify(routes);
   if(key!==activeKey){active?.stop();active=null;activeKey='';if(routes.length){active=await serveInstallationFips(routes);activeKey=key;}}
   await bridge('write',{status:{...status,observed_at:Date.now(),ingress:active?'listening':'not_configured',remote_reachability:'not_verified',operation:nextOperation},operation:nextOperation});
  }catch{active?.stop();active=null;activeKey='';console.error('NStack host helper is waiting for the local installation or host readiness.');}
  await Bun.sleep(3000);
 }
}else if(command==='serve'){
 const raw=process.argv[3];if(!raw)throw Error('Usage: bun scripts/nstack-host.ts serve <public-routes.json>');
 const routes=await Bun.file(raw).json();
 const gateway=await serveInstallationFips(routes);
 console.log(JSON.stringify({state:'listening',peer_npub:gateway.status.peer_npub,routes:gateway.routes,remote_reachability:'not_yet_verified'}));
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{gateway.stop();process.exit(0);});
}else throw Error('Supported operations: status, install, serve, supervise');
