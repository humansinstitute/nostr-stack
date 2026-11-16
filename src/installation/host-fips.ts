import {lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {nip19} from 'nostr-tools';
import {isIP} from 'node:net';
import {createFipsHostGateway} from '../fips-host-gateway';

/** Normative FIPS v0.5.0: fd || SHA256(x-only public key)[0..15]. */
export function fipsPeerAddress(peer:string):string {
 const decoded=nip19.decode(peer);if(decoded.type!=='npub'||nip19.npubEncode(decoded.data)!==peer)throw Error('invalid_peer');
 const bytes=Buffer.concat([Buffer.from([0xfd]),createHash('sha256').update(Buffer.from(decoded.data,'hex')).digest().subarray(0,15)]);
 return Array.from({length:8},(_,i)=>bytes.readUInt16BE(i*2).toString(16)).join(':');
}
export interface HostFipsStatus {state:'ready'|'install_required'|'not_ready';platform:string;peer_npub?:string;mesh_address?:string;requirement?:string;}
export function validateHostFipsStatus(value:any,platform:string=process.platform):HostFipsStatus {
 try{
  if(!['linux','darwin'].includes(platform)||value.persistent!==true||value.state!=='running'||value.tun_state!=='active')throw Error();
  if(isIP(value.ipv6_addr)!==6||new URL(`http://[${value.ipv6_addr}]`).hostname!==new URL(`http://[${fipsPeerAddress(value.npub)}]`).hostname)throw Error();
  return {state:'ready',platform,peer_npub:value.npub,mesh_address:value.ipv6_addr};
 }catch{return {state:'not_ready',platform,requirement:'The existing daemon must have a persistent identity, active TUN and matching peer-derived IPv6. Do not replace its identity.'};}
}
export function classifyHostFipsProbe(input:{platform:string;binaryPresent:boolean;existingState:boolean;exitCode?:number;payload?:unknown}):HostFipsStatus {
 if(!input.binaryPresent)return {state:input.existingState?'not_ready':'install_required',platform:input.platform,requirement:input.existingState?'Existing FIPS state is present but cannot be inspected. Repair permissions/runtime; installation will not overwrite it.':'Install the supported host FIPS daemon through normal OS authorization. Local NStack remains usable.'};
 if(input.exitCode!==0)return {state:'not_ready',platform:input.platform,requirement:'Existing daemon is stopped, denied or unavailable. Repair its control access without reinstalling or changing identity.'};
 return validateHostFipsStatus(input.payload,input.platform);
}
export async function inspectHostFips():Promise<HostFipsStatus>{
 const present=(path:string)=>{try{lstatSync(path);return true;}catch(e){return (e as NodeJS.ErrnoException).code!=='ENOENT';}};
 const binary=[Bun.which('fipsctl'),'/usr/local/bin/fipsctl','/usr/bin/fipsctl'].find((p):p is string=>Boolean(p&&present(p)));
 const existingState=['/etc/fips/fips.yaml','/usr/local/etc/fips/fips.yaml','/Library/LaunchDaemons/com.fips.daemon.plist','/etc/systemd/system/fips.service'].some(present);
 if(!binary)return classifyHostFipsProbe({platform:process.platform,binaryPresent:false,existingState});
 try{
  const child=Bun.spawn([binary,'--socket','/var/run/fips/control.sock','show','status'],{stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill(),5000);
  const [code,output]=await Promise.all([child.exited,new Response(child.stdout).text()]).finally(()=>clearTimeout(timer));
  return classifyHostFipsProbe({platform:process.platform,binaryPresent:true,existingState,exitCode:code,payload:code===0?JSON.parse(output):undefined});
 }catch{return classifyHostFipsProbe({platform:process.platform,binaryPresent:true,existingState,exitCode:1});}
}
export function installationFipsRoutes(settings:any,status:HostFipsStatus):{service:InstallationFipsService;port:number}[]{
 if(!settings.fips_desired||!settings.fips||status.state!=='ready')return [];
 if(settings.fips.peer_npub!==status.peer_npub||new URL(`http://[${settings.fips.mesh_address}]`).hostname!==new URL(`http://[${status.mesh_address}]`).hostname)throw Error('configured_host_identity_mismatch');
 const routes:{service:InstallationFipsService;port:number}[]=[{service:'tower',port:settings.fips.port}];
 for(const service of ['relay','blossom','git'] as const){
  const module=settings.modules?.[service];if(!module?.enabled)continue;
  const origin=new URL(module.origin);
  const isFips=origin.hostname.endsWith('.fips');
  if(isFips&&origin.hostname!==status.peer_npub+'.fips')throw Error('module_host_peer_mismatch');
  const port=isFips?Number(origin.port):settings.fips_service_ports?.[service]??{relay:43112,blossom:43113,git:43114}[service];
  routes.push({service,port});
 }
 if(routes.some(r=>!Number.isInteger(r.port)||r.port<1024||r.port>65535)||new Set(routes.map(r=>r.port)).size!==routes.length)throw Error('invalid_service_routes');
 return routes;
}

export const INSTALLATION_FIPS_SERVICES={tower:43111,relay:17777,blossom:13002,git:17334} as const;
export type InstallationFipsService=keyof typeof INSTALLATION_FIPS_SERVICES;
export async function serveInstallationFips(routes:{service:InstallationFipsService;port:number}[]){
 const status=await inspectHostFips();if(status.state!=='ready')throw Error(status.requirement);
 if(!routes.length||routes.length>4||new Set(routes.map(r=>r.service)).size!==routes.length||new Set(routes.map(r=>r.port)).size!==routes.length)throw Error('invalid_service_routes');
 for(const route of routes)if(!(route.service in INSTALLATION_FIPS_SERVICES)||!Number.isInteger(route.port)||route.port<1024||route.port>65535)throw Error('invalid_service_route');
 const gateways:ReturnType<typeof createFipsHostGateway>[]=[];
 try{
  for(const route of routes){
   const gateway=createFipsHostGateway(INSTALLATION_FIPS_SERVICES[route.service]);gateways.push(gateway);
   await new Promise<void>((resolve,reject)=>{gateway.server.once('error',reject);gateway.server.listen({host:status.mesh_address!,port:route.port,ipv6Only:true},()=>{gateway.server.removeListener('error',reject);resolve();});});
  }
 }catch(e){for(const gateway of gateways)gateway.stop();throw e;}
 return {status,routes,stop(){for(const gateway of gateways)gateway.stop();}};
}

export function hostInstallationCompletion(exitCode:number,status:HostFipsStatus):'complete'|'failed'|'awaiting_os_authorization'{
 return exitCode!==0?'failed':status.state==='ready'?'complete':'awaiting_os_authorization';
}
