import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {readFipsIngressConfig} from '../fips-ingress';
export interface InstallationSettings {
  version:1; https_origin:string; fips_desired:boolean;
  fips?:{peer_npub:string;mesh_address:string;port:number};
}
export const installationEnvironmentLocks={https_origin:process.env.SUPERBASED_DIRECT_HTTPS_URL!==undefined,fips_desired:process.env.NSTACK_FIPS_DESIRED!==undefined,fips:process.env.TOWER_FIPS_ENABLED!==undefined};
export const defaultSettings:InstallationSettings={version:1,https_origin:'',fips_desired:true};
export function validateInstallationSettings(value:unknown):InstallationSettings{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_settings');
 const v=value as InstallationSettings;
 if(Object.keys(v).some(k=>!['version','https_origin','fips_desired','fips'].includes(k))||v.version!==1||typeof v.https_origin!=='string'||typeof v.fips_desired!=='boolean')throw Error('invalid_settings');
 if(v.https_origin){const u=new URL(v.https_origin);if(u.protocol!=='https:'||u.origin!==v.https_origin)throw Error('https_origin_required');}
 if(v.fips){
  if(Object.keys(v.fips).sort().join(',')!=='mesh_address,peer_npub,port')throw Error('invalid_fips_settings');
  readFipsIngressConfig({TOWER_FIPS_ENABLED:'true',TOWER_FIPS_NODE_NPUB:v.fips.peer_npub,TOWER_FIPS_MESH_ADDRESS:v.fips.mesh_address,TOWER_FIPS_PORT:String(v.fips.port),TOWER_FIPS_INGRESS_MODE:'docker'});
 }
 return v;
}
export function readInstallationSettings(directory=process.env.NSTACK_SETTINGS_DIRECTORY):InstallationSettings{
 if(!directory)return {...defaultSettings};
 try{return validateInstallationSettings(JSON.parse(readFileSync(join(directory,'settings.json'),'utf8')));}
 catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {...defaultSettings};throw Error('Invalid persisted installation settings; use controller recovery');}
}
export function settingsEnvironment(settings:InstallationSettings):Record<string,string>{
 return {SUPERBASED_DIRECT_HTTPS_URL:settings.https_origin,NSTACK_FIPS_DESIRED:String(settings.fips_desired),
  TOWER_FIPS_ENABLED:String(Boolean(settings.fips_desired&&settings.fips)),
  ...(settings.fips?{TOWER_FIPS_NODE_NPUB:settings.fips.peer_npub,TOWER_FIPS_MESH_ADDRESS:settings.fips.mesh_address,TOWER_FIPS_PORT:String(settings.fips.port),TOWER_FIPS_INGRESS_MODE:'docker'}:{})};
}
/** Explicit deployment env wins over operator settings. Secrets are excluded. */
export function loadInstallationSettings(){
 if(!process.env.NSTACK_SETTINGS_DIRECTORY)return;
 for(const [key,value] of Object.entries(settingsEnvironment(readInstallationSettings())))if(process.env[key]===undefined)process.env[key]=value;
}
