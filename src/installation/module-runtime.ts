import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {nip19} from 'nostr-tools';
import {MODULE_CATALOGUE,MODULE_NAMES,validateModuleSettings,type ModuleName,type ModuleSettings} from './modules';

/** Host-controller-only capability. Never wire DockerRequest to an HTTP route. */
export type DockerRequest=(path:string,method?:string,body?:unknown)=>Promise<Response>;
export interface ModuleStatus {module:ModuleName;configured:boolean;desired:boolean;runtime:'disabled'|'missing'|'stopped'|'unhealthy'|'ready'|'unavailable';error?:string;local:{port:number|null;protocol:string;path:string};}
const LABEL='io.wingman.nstack.module';
const CONFIG='io.wingman.nstack.config';
const MANAGED='io.wingman.nstack.managed';
const projectLabel='com.docker.compose.project';
const idPattern=/^[a-f0-9]{64}$/;
const fixedFile=(name:string)=>readFile(fileURLToPath(new URL('../../deploy/setup-modules/'+name,import.meta.url)),'utf8');

/** Minimal deterministic archive for fixed in-image config destinations only. */
function archive(files:Record<string,string>):Uint8Array {
  const blocks:Buffer[]=[];
  for(const [name,content] of Object.entries(files)){
    if(name.length>99||name.startsWith('/')||name.split('/').includes('..'))throw Error('invalid_internal_archive_path');
    const data=Buffer.from(content),header=Buffer.alloc(512);
    header.write(name,0,100,'utf8');header.write('0000644\0',100,8);header.write('0000000\0',108,8);header.write('0000000\0',116,8);
    header.write(data.length.toString(8).padStart(11,'0')+'\0',124,12);header.write('00000000000\0',136,12);header.fill(32,148,156);header[156]=48;
    header.write('ustar\0',257,6);header.write('00',263,2);
    const sum=header.reduce((a,b)=>a+b,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8);
    blocks.push(header,data,Buffer.alloc((512-data.length%512)%512));
  }
  return Buffer.concat([...blocks,Buffer.alloc(1024)]);
}
export function createModuleRuntime(options:{project:string;docker?:DockerRequest;probeAttempts?:number;probeDelayMs?:number}) {
  const project=options.project;
  if(!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project))throw Error('exact_module_project_required');
  const request:DockerRequest=options.docker??(async(path,method='GET',body)=>fetch('http://localhost/v1.47'+path,{method,unix:'/var/run/docker.sock',headers:body instanceof Uint8Array?{'content-type':'application/x-tar'}:{'content-type':'application/json'},body:body===undefined?undefined:body instanceof Uint8Array?new Uint8Array(body).buffer:JSON.stringify(body),signal:AbortSignal.timeout(path.startsWith('/images/create?')?180000:15000)}));
  async function api(path:string,method='GET',body?:unknown):Promise<any>{
    const r=await request(path,method,body);
    if(!r.ok)throw Error(`module_docker_${r.status}`);
    if(r.status===204||r.headers.get('content-length')==='0')return;
    const text=await r.text();return text?JSON.parse(text):undefined;
  }
  const name=(module:ModuleName)=>`${project}-module-${module}`;
  const labels=(module:ModuleName)=>({[projectLabel]:project,[LABEL]:module,[MANAGED]:'v1'});
  function owned(value:any,module:ModuleName,kind:'container'|'resource'){
    const l=kind==='container'?value.Config?.Labels:value.Labels;
    if(!l||Object.entries(labels(module)).some(([k,v])=>l[k]!==v))throw Error('module_resource_not_owned');
  }
  async function inspect(module:ModuleName,backup=false):Promise<any|undefined>{
    const r=await request('/containers/'+name(module)+(backup?'-previous':'')+'/json');
    if(r.status===404)return;
    if(!r.ok)throw Error('module_inspection_failed');
    const c=await r.json();owned(c,module,'container');if(!idPattern.test(c.Id))throw Error('invalid_module_container_id');return c;
  }
  async function resource(module:ModuleName,kind:'networks'|'volumes',suffix:string,internal=false){
    const n=name(module)+'-'+suffix;
    const r=await request('/'+kind+'/'+n);
    if(r.ok){const found=await r.json();owned(found,module,'resource');if(kind==='networks'&&found.Internal!==internal)throw Error('module_network_policy_mismatch');}
    else if(r.status===404){
      await api('/'+kind+'/create','POST',kind==='networks'?{Name:n,Driver:'bridge',Internal:internal,Labels:labels(module)}:{Name:n,Labels:labels(module)});
      const verified=await api('/'+kind+'/'+n);owned(verified,module,'resource');
    }else throw Error('module_resource_inspection_failed');
    return n;
  }
  async function exec(module:ModuleName,cmd:string[]):Promise<{ok:boolean;output:string}>{
    const c=await inspect(module);if(!c||!c.State?.Running)return {ok:false,output:''};
    const e=await api('/containers/'+c.Id+'/exec','POST',{AttachStdout:true,AttachStderr:true,Cmd:cmd,User:'0'});
    if(!idPattern.test(e.Id))throw Error('invalid_module_exec_id');
    const r=await request('/exec/'+e.Id+'/start','POST',{Detach:false,Tty:false});
    if(!r.ok)throw Error('module_exec_failed');
    const b=Buffer.from(await r.arrayBuffer());let output='';
    for(let p=0;p+8<=b.length;){const length=b.readUInt32BE(p+4);if(p+8+length>b.length)throw Error('module_exec_output_invalid');output+=b.subarray(p+8,p+8+length).toString();p+=8+length;}
    const state=await api('/exec/'+e.Id+'/json');return {ok:state.ExitCode===0&&!state.Running,output};
  }
  async function files(module:ModuleName,m:ModuleSettings):Promise<Record<string,string>> {
    if(module==='relay')return {'relay.sh':await fixedFile('relay-entrypoint.sh')};
    if(module==='blossom')return {'config.yml':await readFile(fileURLToPath(new URL('../../deploy/nstack/blossom.yml',import.meta.url)),'utf8')};
    if(module==='graph')return {'graph.sh':await fixedFile('graph-entrypoint.sh')};
    const readers=Object.fromEntries(Object.entries(m.git.repository_readers).map(([key,value])=>[key,value.map(k=>nip19.npubEncode(k))]));
    return {'repository-readers.json':JSON.stringify(readers)};
  }
  async function spec(module:ModuleName,m:ModuleSettings){
    const catalogue=MODULE_CATALOGUE[module];
    let imageResponse=await request('/images/'+encodeURIComponent(catalogue.image)+'/json');
    if(imageResponse.status===404){
      if(module==='git')throw Error('module_image_distribution_unavailable_git');
      const pulled=await request('/images/create?fromImage='+encodeURIComponent(catalogue.image),'POST');
      if(!pulled.ok||!pulled.body)throw Error('module_image_provision_failed_'+module);
      const reader=pulled.body.getReader();const decoder=new TextDecoder();let pending='';
      try{
        while(true){const chunk=await reader.read();if(chunk.done)break;pending+=decoder.decode(chunk.value,{stream:true});
          if(pending.length>1048576)throw Error('module_image_progress_invalid');
          let newline;while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(line.trim()){const item=JSON.parse(line);if(item.error||item.errorDetail)throw Error('module_image_provision_failed_'+module);}}
        }
        if(pending.trim()){const item=JSON.parse(pending);if(item.error||item.errorDetail)throw Error('module_image_provision_failed_'+module);}
      }finally{await reader.cancel();}
      imageResponse=await request('/images/'+encodeURIComponent(catalogue.image)+'/json');
    }
    if(!imageResponse.ok)throw Error('module_image_inspection_failed_'+module);
    const image=await imageResponse.json();if(!/^sha256:[a-f0-9]{64}$/.test(image.Id))throw Error('invalid_module_image_id');
    if(module==='git'&&image.Config?.Labels?.['org.opencontainers.image.revision']!=='nstack-repository-access-v1')throw Error('private_git_patch_required');
    const network=await resource(module,'networks','network',module==='graph');
    const data=await resource(module,'volumes','data');
    const configVolume=await resource(module,'volumes','config-'+hash(m[module]).slice(0,16));
    const env:string[]=[];
    const mounts:any[]=[{Type:'volume',Source:configVolume,Target:'/run/module-config'},{Type:'volume',Source:data,Target:module==='graph'?'/var/lib/postgresql/data':module==='relay'?'/usr/src/app/db':module==='blossom'?'/app/data':'/data'}];
    let entrypoint:string[]|undefined;let cmd:string[]|undefined;
    if(module==='relay'){
      entrypoint=['/bin/bash','/run/module-config/relay.sh'];env.push('NOSTR_RELAY_PUBLIC_ORIGIN='+m.relay.origin,'NOSTR_RELAY_PUBLISH_PUBKEYS='+m.relay.publishers.join(','));
    }else if(module==='blossom'){entrypoint=['deno'];cmd=['run','-P','--env-file=.env','main.ts','/run/module-config/config.yml'];env.push('BLOSSOM_REQUIRE_CONFIG=1','BLOSSOM_PUBLIC_DOMAIN='+m.blossom.origin,'BLOSSOM_PUBLISH_PUBKEY='+m.blossom.publisher);}
    else if(module==='graph'){
      const state=await resource(module,'volumes','state');mounts.push({Type:'volume',Source:state,Target:'/run/module-state'});
      entrypoint=['/bin/sh','/run/module-config/graph.sh'];cmd=['postgres','-c','shared_preload_libraries=age'];
    }else {
      env.push('NGIT_DOMAIN='+new URL(m.git.origin).host,'NGIT_PRIVATE_PUBLIC_ORIGIN='+m.git.origin,'NGIT_PRIVATE_MODE=true','NGIT_PRIVATE_REPOSITORY_READERS_FILE=/run/module-config/repository-readers.json','NGIT_PRIVATE_MEMBERS='+m.git.members.map(k=>nip19.npubEncode(k)).join(','),'NGIT_REPOSITORY_WHITELIST='+m.git.maintainers.map(k=>nip19.npubEncode(k)).join(','),'NGIT_GRASP06_ENABLE=false','NGIT_SYNC_PLUS_ENABLED=false','NGIT_USER_INDEX_RELAYS=','NGIT_SYNC_PLUS_FALLBACK_RELAYS=','NGIT_DATABASE_BACKEND=lmdb','NGIT_BIND_ADDRESS=0.0.0.0:7334','NGIT_RELAY_NAME=Wingman private GRasp','NGIT_GIT_DATA_PATH=/data/git','NGIT_RELAY_DATA_PATH=/data/relay');
    }
    const port=catalogue.port+'/tcp';
    return {Image:image.Id,Env:env,...(entrypoint?{Entrypoint:entrypoint}:{}),...(cmd?{Cmd:cmd}:{}),Labels:{...labels(module),[CONFIG]:hash(m[module])},ExposedPorts:{[port]:{}},HostConfig:{NetworkMode:network,Mounts:mounts,RestartPolicy:{Name:'unless-stopped'},ReadonlyRootfs:module!=='graph'&&module!=='git',SecurityOpt:['no-new-privileges:true'],...(module==='graph'?{}:module==='git'?{CapDrop:['ALL'],CapAdd:['CHOWN','FOWNER','SETUID','SETGID','DAC_OVERRIDE']}:{CapDrop:['ALL']}),PidsLimit:256,Memory:module==='blossom'?2147483648:1073741824,NanoCpus:1000000000,Tmpfs:module==='blossom'?{'/tmp':'size=268435456,mode=1777','/deno-dir':'size=1073741824,mode=1777,exec'}:{'/tmp':'size=8388608,mode=1777'},PortBindings:catalogue.hostPort?{[port]:[{HostIp:'127.0.0.1',HostPort:String(catalogue.hostPort)}]}:{}},NetworkingConfig:{EndpointsConfig:{[network]:{Aliases:['nstack-module-'+module]}}}};
  }
  const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  async function stop(c:any){if(c.State?.Running)await api('/containers/'+c.Id+'/stop?t=30','POST');}
  async function remove(c:any){await stop(c);await api('/containers/'+c.Id+'?v=0','DELETE');}
  const probes:Record<ModuleName,string[]>={
    graph:['/bin/sh','-ec','export PGPASSWORD=$(cat /run/module-state/admin-password); psql -h 127.0.0.1 -U nstack_graph_admin -d tower_graph -tAc "SELECT 1 FROM pg_available_extensions WHERE name = \'age\'" | grep -qx 1'],
    relay:['/bin/bash','-ec',"exec 3<>/dev/tcp/127.0.0.1/8080; printf 'GET / HTTP/1.1\\r\\nHost: localhost\\r\\nAccept: application/nostr+json\\r\\nConnection: close\\r\\n\\r\\n' >&3; read -r status <&3; [[ $status == *' 200 '* ]]"],
    blossom:['deno','eval',"const r=await fetch('http://127.0.0.1:3000/');if(!r.ok)Deno.exit(1);const u=await fetch('http://127.0.0.1:3000/upload',{method:'PUT',body:'unauthorized-probe'});if(![401,403].includes(u.status))Deno.exit(1)"],
    git:['curl','--fail','--silent','--header','Accept: application/nostr+json','http://127.0.0.1:7334/'],
  };
  async function probe(module:ModuleName){
    const c=await inspect(module);if(!c?.State?.Running)return false;
    const result=await exec(module,probes[module]);if(!result.ok)return false;
    if(module==='git'){try {const doc=JSON.parse(result.output);return Array.isArray(doc.supported_nips)&&doc.supported_nips.includes(42);}catch{return false;}}
    return true;
  }
  async function wait(module:ModuleName){
    for(let i=0;i<(options.probeAttempts??60);i++){
      try{if(await probe(module))return;}catch{}
      if(i+1<(options.probeAttempts??60))await Bun.sleep(options.probeDelayMs??1000);
    }throw Error('module_readiness_failed_'+module);
  }
  async function recover(module:ModuleName,shouldRun:boolean){
    const previous=await inspect(module,true);if(!previous)return;
    const current=await inspect(module);if(current)await remove(current);
    await api('/containers/'+previous.Id+'/rename?name='+name(module),'POST');
    if(shouldRun)await api('/containers/'+previous.Id+'/start','POST');
  }
  let active=false;
  /** Reconcile all affected modules as one transaction. Volumes are never removed.
   * Interrupted backup containers are restored before retry. Controller's durable
   * ledger/settings remain the authority for selecting previous vs desired. */
  async function apply(previousValue:ModuleSettings,desiredValue:ModuleSettings){
    const previous=validateModuleSettings(previousValue),desired=validateModuleSettings(desiredValue);
    if(active)throw Error('module_operation_in_progress');active=true;
    const changed:ModuleName[]=[];
    const stopped:ModuleName[]=[];
    const startedExisting:ModuleName[]=[];
    const priorRunning=new Map<ModuleName,boolean>();
    let recoveryPending=true;
    try{
      for(const module of MODULE_NAMES)await recover(module,previous[module].enabled);
      recoveryPending=false;
      for(const module of MODULE_NAMES){
        const current=await inspect(module);
        if(!desired[module].enabled){if(current?.State?.Running){stopped.push(module);await stop(current);}continue;}
        if(current&&current.Config.Labels[CONFIG]===hash(desired[module])){
          if(desired[module].enabled){if(!current.State?.Running){startedExisting.push(module);await api('/containers/'+current.Id+'/start','POST');}await wait(module);}else await stop(current);
          continue;
        }
        if(!current&&!desired[module].enabled)continue;
        // Resolve images and provision resources BEFORE interrupting prior service.
        const body=desired[module].enabled?await spec(module,desired):undefined;
        changed.push(module);
        if(current){priorRunning.set(module,Boolean(current.State?.Running));await stop(current);await api('/containers/'+current.Id+'/rename?name='+name(module)+'-previous','POST');}
        if(body){
          const created=await api('/containers/create?name='+name(module),'POST',body);
          if(!idPattern.test(created.Id))throw Error('invalid_module_container_id');
          const checked=await inspect(module);if(checked?.Id!==created.Id)throw Error('module_container_identity_mismatch');
          const uploaded=await request('/containers/'+created.Id+'/archive?path=/run/module-config','PUT',archive(await files(module,desired)));
          if(!uploaded.ok)throw Error('module_configuration_failed_'+module);
          await api('/containers/'+created.Id+'/start','POST');await wait(module);
        }
      }
      // Do not delete any prior container until all desired modules passed probes.
      const cleanupPending:ModuleName[]=[];
      for(const module of changed){try{const backup=await inspect(module,true);if(backup)await remove(backup);}catch{cleanupPending.push(module);}}
      return {state:'committed' as const,modules:await status(desired),cleanupPending};
    }catch(error){
      let restored=!recoveryPending;
      for(const module of startedExisting){try{const c=await inspect(module);if(c)await stop(c);}catch{restored=false;}}
      for(const module of stopped){try{const c=await inspect(module);if(c)await api('/containers/'+c.Id+'/start','POST');await wait(module);}catch{restored=false;}}
      for(const module of changed.reverse()){
        try{const current=await inspect(module);if(current)await remove(current);await recover(module,priorRunning.get(module)??previous[module].enabled);if(priorRunning.get(module)??previous[module].enabled)await wait(module);}catch{restored=false;}
      }
      return {state:restored?'rolled_back' as const:'recovery_required' as const,error:error instanceof Error?error.message:'module_apply_failed'};
    }finally{active=false;}
  }
  async function status(value:ModuleSettings):Promise<ModuleStatus[]>{
    const desired=validateModuleSettings(value);
    return Promise.all(MODULE_NAMES.map(async module=>{
      const c=MODULE_CATALOGUE[module];
      const result:ModuleStatus={module,configured:module==='graph'||Boolean((desired[module] as any).origin),desired:desired[module].enabled,runtime:'disabled',local:{port:c.hostPort,protocol:c.protocol,path:c.path}};
      try{
        const found=await inspect(module);
        if(!desired[module].enabled){result.runtime=found?.State?.Running?'unhealthy':'disabled';return result;}
        result.runtime=!found?'missing':!found.State?.Running?'stopped':found.Config.Labels[CONFIG]!==hash(desired[module])?'unhealthy':await probe(module)?'ready':'unhealthy';
      }catch(e){result.runtime='unavailable';result.error=e instanceof Error?e.message:'module_status_failed';}
      return result;
    }));
  }
  async function verify(value:ModuleSettings){return (await status(value)).every(s=>s.desired?s.runtime==='ready':s.runtime==='disabled');}
  /** Trusted controller only. Do not serialize this result to an API or journal.
   * Mount the graph network and state read-only into Tower, then run its existing
   * graph migrations with these credentials before advertising graph readiness. */
  async function graphEnvironment():Promise<Record<string,string>>{
    const result=await exec('graph',['/bin/sh','-ec','cat /run/module-state/admin-password /run/module-state/app-password']);
    const [admin,app]=result.output.trim().split('\n');
    if(!result.ok||!(/^[a-f0-9]{64}$/.test(admin??''))||!(/^[a-f0-9]{64}$/.test(app??'')))throw Error('graph_protected_state_unavailable');
    return {GRAPH_DB_HOST:'nstack-module-graph',GRAPH_DB_PORT:'5432',GRAPH_DB_NAME:'tower_graph',GRAPH_DB_ADMIN_USER:'nstack_graph_admin',GRAPH_DB_ADMIN_PASSWORD:admin,GRAPH_DB_APP_USER:'nstack_graph_app',GRAPH_DB_APP_PASSWORD:app};
  }
  /** Attach only this installation's uniquely labelled Tower. No caller IDs,
   * network names or arbitrary endpoints cross the controller boundary. */
  async function connectTower(value:ModuleSettings){
    const desired=validateModuleSettings(value);
    const filters=encodeURIComponent(JSON.stringify({label:[`${projectLabel}=${project}`,'com.docker.compose.service=tower']}));
    const matches=await api('/containers/json?all=1&filters='+filters);
    if(!Array.isArray(matches)||matches.length!==1||!idPattern.test(matches[0].Id))throw Error('module_tower_container_ambiguous');
    const tower=await api('/containers/'+matches[0].Id+'/json');
    if(tower.Id!==matches[0].Id||tower.Config?.Labels?.[projectLabel]!==project||tower.Config?.Labels?.['com.docker.compose.service']!=='tower')throw Error('module_tower_container_not_owned');
    for(const module of MODULE_NAMES){
      const networkName=name(module)+'-network';
      const response=await request('/networks/'+networkName);
      if(response.status===404&&!desired[module].enabled)continue;
      if(!response.ok)throw Error('module_network_not_available_'+module);
      const network=await response.json();owned(network,module,'resource');
      if(!idPattern.test(network.Id))throw Error('invalid_module_network_id');
      const connected=tower.NetworkSettings?.Networks?.[networkName];
      if(connected&&connected.NetworkID!==network.Id)throw Error('module_tower_network_mismatch');
      if(desired[module].enabled&&!connected)await api('/networks/'+network.Id+'/connect','POST',{Container:tower.Id});
      if(!desired[module].enabled&&connected)await api('/networks/'+network.Id+'/disconnect','POST',{Container:tower.Id,Force:false});
    }
  }
  return {apply,status,verify,graphEnvironment,connectTower};
}
