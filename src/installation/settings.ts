import {validateModuleSettings,defaultModuleSettings,moduleEnvironment,type ModuleSettings} from './modules';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {readFipsIngressConfig} from '../fips-ingress';
export interface InstallationSettings {
  version:1; https_origin:string; fips_desired:boolean;
  modules?:ModuleSettings;
  fips_service_ports?:{relay?:number;blossom?:number;git?:number};
  fips?:{peer_npub:string;mesh_address:string;port:number};
}
export const installationEnvironmentLocks={https_origin:process.env.SUPERBASED_DIRECT_HTTPS_URL!==undefined,fips_desired:process.env.NSTACK_FIPS_DESIRED!==undefined,fips:process.env.TOWER_FIPS_ENABLED!==undefined};
export const defaultSettings:InstallationSettings={version:1,https_origin:'',fips_desired:true,modules:defaultModuleSettings()};
export function validateInstallationSettings(value:unknown):InstallationSettings{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_settings');
 const v=value as InstallationSettings;
 if(Object.keys(v).some(k=>!['version','https_origin','fips_desired','fips','modules','fips_service_ports'].includes(k))||v.version!==1||typeof v.https_origin!=='string'||typeof v.fips_desired!=='boolean')throw Error('invalid_settings');
 if(v.https_origin){const u=new URL(v.https_origin);if(u.protocol!=='https:'||u.origin!==v.https_origin)throw Error('https_origin_required');}
 if(v.fips){
  if(v.fips.port<1024)throw Error('installation_fips_port_requires_unprivileged_range');
  if(Object.keys(v.fips).sort().join(',')!=='mesh_address,peer_npub,port')throw Error('invalid_fips_settings');
  readFipsIngressConfig({TOWER_FIPS_ENABLED:'true',TOWER_FIPS_NODE_NPUB:v.fips.peer_npub,TOWER_FIPS_MESH_ADDRESS:v.fips.mesh_address,TOWER_FIPS_PORT:String(v.fips.port),TOWER_FIPS_INGRESS_MODE:'docker'});
 }
 const modules=validateModuleSettings(v.modules);
 if(v.fips_service_ports){if(Object.keys(v.fips_service_ports).some(k=>!['relay','blossom','git'].includes(k))||Object.values(v.fips_service_ports).some(p=>!Number.isInteger(p)||p<1024||p>65535))throw Error('invalid_fips_service_ports');}
 if(v.fips){
  const ports=[v.fips.port];
  for(const name of ['relay','blossom','git'] as const){if(!modules[name].enabled)continue;const u=new URL(modules[name].origin);
   if(u.hostname.endsWith('.fips')&&u.hostname!==v.fips.peer_npub+'.fips')throw Error('module_host_peer_mismatch');
   ports.push(u.hostname.endsWith('.fips')?Number(u.port):v.fips_service_ports?.[name]??{relay:43112,blossom:43113,git:43114}[name]);
  }
  if(new Set(ports).size!==ports.length)throw Error('duplicate_fips_service_port');
 }
 return {...v,modules};
}
export function readInstallationSettings(directory=process.env.NSTACK_SETTINGS_DIRECTORY):InstallationSettings{
 if(!directory)return {...defaultSettings};
 try{return validateInstallationSettings(JSON.parse(readFileSync(join(directory,'settings.json'),'utf8')));}
 catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {...defaultSettings};throw Error('Invalid persisted installation settings; use controller recovery');}
}
export function settingsEnvironment(settings:InstallationSettings):Record<string,string>{
 return {...moduleEnvironment(settings.modules||defaultModuleSettings()),SUPERBASED_DIRECT_HTTPS_URL:settings.https_origin,NSTACK_FIPS_DESIRED:String(settings.fips_desired),
  TOWER_FIPS_ENABLED:String(Boolean(settings.fips_desired&&settings.fips)),
  NSTACK_MODULE_FIPS_ROUTES:String(Boolean(settings.fips_desired&&settings.fips)),
  NSTACK_RELAY_FIPS_PORT:String(settings.fips_service_ports?.relay??43112),NSTACK_BLOSSOM_FIPS_PORT:String(settings.fips_service_ports?.blossom??43113),NSTACK_GRASP_FIPS_PORT:String(settings.fips_service_ports?.git??43114),
  ...(settings.fips?{TOWER_FIPS_NODE_NPUB:settings.fips.peer_npub,TOWER_FIPS_MESH_ADDRESS:settings.fips.mesh_address,TOWER_FIPS_PORT:String(settings.fips.port),TOWER_FIPS_INGRESS_MODE:'docker'}:{})};
}
/** Explicit deployment env wins over operator settings. Secrets are excluded. */
export function loadInstallationSettings(){
 if(!process.env.NSTACK_SETTINGS_DIRECTORY)return;
 const settings=readInstallationSettings();
 for(const [key,value] of Object.entries(settingsEnvironment(settings)))if(process.env[key]===undefined)process.env[key]=value;
 if(settings.modules?.graph.enabled){
  const graph=JSON.parse(readFileSync(join(process.env.NSTACK_SETTINGS_DIRECTORY,'graph.json'),'utf8'));
  const allowed=['GRAPH_DB_HOST','GRAPH_DB_PORT','GRAPH_DB_NAME','GRAPH_DB_ADMIN_USER','GRAPH_DB_ADMIN_PASSWORD','GRAPH_DB_APP_USER','GRAPH_DB_APP_PASSWORD'];
  if(Object.keys(graph).some(k=>!allowed.includes(k))||allowed.some(k=>typeof graph[k]!=='string'))throw Error('Invalid protected graph configuration');
  for(const [key,value] of Object.entries(graph))if(process.env[key]===undefined)process.env[key]=String(value);
 }
}
