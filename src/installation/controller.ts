import {controllerStore} from './controller-store';
import {randomBytes} from 'node:crypto';
import {verifyEvent,nip19} from 'nostr-tools';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {validateInstallationSettings,defaultSettings,type InstallationSettings} from './settings';
export interface ControllerOperation {id:string;state:'pending'|'applying'|'verifying'|'committed'|'rolled_back'|'recovery_required';desired:InstallationSettings;previous?:InstallationSettings;error?:string;}
export async function atomicJson(path:string,value:unknown){
 const temp=path+'.tmp';await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,path);
}
export async function runControllerOperation(directory:string,operation:ControllerOperation,adapter:{restart:()=>Promise<void>;verify:()=>Promise<boolean>;persist?:(operation:ControllerOperation)=>void}){
 const journal=join(directory,'operation.json'),settings=join(directory,'settings.json');
 const persist=async()=>{if(adapter.persist)adapter.persist(operation);else await atomicJson(journal,operation);};
 validateInstallationSettings(operation.desired);
 let previous=operation.previous;
 if(!previous){try{previous=validateInstallationSettings(JSON.parse(await readFile(settings,'utf8')));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;previous={...defaultSettings};}}
 operation.previous=previous;
 const recovering=operation.state==='applying'||operation.state==='verifying'||operation.state==='recovery_required';
 try{
  if(recovering)throw Error('interrupted_operation');
  operation.state='applying';await persist();
  await atomicJson(settings,operation.desired);await adapter.restart();
  operation.state='verifying';await persist();
  if(!await adapter.verify())throw Error('health_verification_failed');
  operation.state='committed';await persist();
 }catch{
  operation.error=recovering?'interrupted_operation':'apply_or_verify_failed';
  await atomicJson(settings,previous);
  try{await adapter.restart();if(!await adapter.verify())throw Error();operation.state='rolled_back';}
  catch{operation.state='recovery_required';}
  await persist();
 }
 return operation;
}

if(import.meta.main){
 const directory=process.env.NSTACK_SETTINGS_DIRECTORY||'/run/nstack-settings';
 const project=process.env.NSTACK_COMPOSE_PROJECT;
 if(!project||!/^[a-z0-9][a-z0-9_-]*$/.test(project))throw Error('Exact installation Compose project required');
 await mkdir(directory,{recursive:true,mode:0o700});
 const docker=async(path:string,method='GET')=>{
  const r=await fetch('http://localhost/v1.47'+path,{method,unix:'/var/run/docker.sock'});
  if(!r.ok)throw Error('controller_docker_request_failed');return r;
 };
 const restart=async()=>{
  const filters=encodeURIComponent(JSON.stringify({label:[`com.docker.compose.project=${project}`,'com.docker.compose.service=tower']}));
  const containers=await (await docker('/containers/json?all=1&filters='+filters)).json();
  if(!Array.isArray(containers)||containers.length!==1||! /^[a-f0-9]{64}$/.test(containers[0].Id))throw Error('installation_container_ambiguous');
  await docker('/containers/'+containers[0].Id+'/restart?t=10','POST');
 };
 const verify=async()=>{
  for(let i=0;i<30;i++){
   try{
    const r=await fetch('http://tower:3100/health',{signal:AbortSignal.timeout(2000)});
    if(r.ok){
     const local=await r.json();const settings=validateInstallationSettings(JSON.parse(await readFile(join(directory,'settings.json'),'utf8')));
     if(!settings.https_origin)return true;
     const nonce=randomBytes(32).toString('hex');const url=settings.https_origin+'/api/v4/installation/identity-proof?nonce='+nonce;
     const remote=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(5000)});if(!remote.ok)return false;
     const {proof}=await remote.json();if(!verifyEvent(proof)||proof.kind!==30384||nip19.npubEncode(proof.pubkey)!==local.service_npub)return false;
     const content=JSON.parse(proof.content);return content.nonce===nonce&&content.request_url===url&&content.service_npub===local.service_npub&&content.expires_at>=Math.floor(Date.now()/1000)&&content.expires_at<=Math.floor(Date.now()/1000)+90;
    }
   }catch{}await Bun.sleep(1000);
  }return false;
 };
 const store=controllerStore(directory);
 while(true){
  try{
   const operation=store.latest();
   if(operation&&['pending','applying','verifying'].includes(operation.state))await runControllerOperation(directory,operation,{restart,verify,persist:store.save});
  }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')console.error('Installation controller cannot process operation; inspect local recovery status.');}
  await Bun.sleep(2000);
 }
}
