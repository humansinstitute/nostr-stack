import {nip19} from 'nostr-tools';

export const MODULE_NAMES = ['graph','relay','blossom','git'] as const;
export type ModuleName = typeof MODULE_NAMES[number];
export interface ModuleSettings {
  graph: {enabled:boolean};
  relay: {enabled:boolean;origin:string;publishers:string[]};
  blossom: {enabled:boolean;origin:string;publisher:string};
  git: {enabled:boolean;origin:string;members:string[];maintainers:string[];repository_readers:Record<string,string[]>};
}
/** Images are deployment authority, never request configuration. GRasp is the
 * reviewed source-pinned private build, not the unpatched public upstream. */
export const MODULE_CATALOGUE = Object.freeze({
  graph: {image:'apache/age:release_PG16_1.6.0@sha256:16aa423d20a31aed36a3313244bf7aa00731325862f20ed584510e381f2feaed',port:5432,hostPort:null,protocol:'postgres',path:'/',private:true},
  relay: {image:'docker.io/scsibug/nostr-rs-relay:0.10.0@sha256:48d54c2d2781577cf3ed2951112f0953dc2c5e7c9d2ea20c64e8c0fa37d16e4d',port:8080,hostPort:17777,protocol:'http+ws',path:'/',private:false},
  blossom: {image:'ghcr.io/hzrd149/blossom-server:6.4.1@sha256:446fa6c4b0ca529a1fbceabf5ea75839b5b76dfb0d0e1d150f3bae5f9a52b3b8',port:3000,hostPort:13002,protocol:'http',path:'/',private:false},
  git: {image:'nstack-grasp@sha256:4aaf778f0bf938745821a146e20dadd48b6b677138bd3350384807ddb1b72194',port:7334,hostPort:17334,protocol:'http+ws',path:'/',private:true},
} as const);
export function defaultModuleSettings():ModuleSettings {
  return {graph:{enabled:false},relay:{enabled:false,origin:'',publishers:[]},blossom:{enabled:false,origin:'',publisher:''},git:{enabled:false,origin:'',members:[],maintainers:[],repository_readers:{}}};
}
function object(value:unknown, keys:string[]):Record<string,any> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))throw Error('invalid_module_settings');
  return value as Record<string,any>;
}
function publicOrigin(value:unknown, ws=false) {
  if(typeof value!=='string')throw Error('invalid_module_origin');
  if(!value)return;
  const u=new URL(value);
  if(u.origin!==value||u.username||u.password||u.search||u.hash||!(ws?['wss:','ws:']:['https:','http:']).includes(u.protocol))throw Error('module_root_origin_required');
  let fips=false;
  if(u.hostname.endsWith('.fips')){
    if(!u.port)throw Error('module_fips_port_required');
    const peer=u.hostname.slice(0,-5);
    try{const decoded=nip19.decode(peer);if(decoded.type!=='npub'||nip19.npubEncode(decoded.data)!==peer)throw Error();fips=true;}catch{throw Error('invalid_module_fips_peer');}
  }
  if(['http:','ws:'].includes(u.protocol)&&!fips&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('module_secure_origin_required');
}
function pubkey(value:unknown):string {
  if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw Error('invalid_module_pubkey');
  return value;
}
function keys(value:unknown):string[] {
  if(!Array.isArray(value)||value.length>256)throw Error('invalid_module_allowlist');
  const result=value.map(pubkey);
  if(new Set(result).size!==result.length)throw Error('duplicate_module_pubkey');
  return result;
}
/** Strict full replacement. No secrets, env maps, mount paths, images or commands. */
export function validateModuleSettings(value:unknown):ModuleSettings {
  if(value===undefined)return defaultModuleSettings();
  const v=object(value,[...MODULE_NAMES]);
  object(v.graph,['enabled']);object(v.relay,['enabled','origin','publishers']);object(v.blossom,['enabled','origin','publisher']);object(v.git,['enabled','origin','members','maintainers','repository_readers']);
  for(const name of MODULE_NAMES)if(typeof v[name].enabled!=='boolean')throw Error('invalid_module_enabled');
  publicOrigin(v.relay.origin,true);publicOrigin(v.blossom.origin);publicOrigin(v.git.origin);
  keys(v.relay.publishers);keys(v.git.members);keys(v.git.maintainers);
  if(v.blossom.publisher!=='')pubkey(v.blossom.publisher);
  const readers=v.git.repository_readers;
  if(!readers||typeof readers!=='object'||Array.isArray(readers)||Object.keys(readers).length>256)throw Error('invalid_repository_readers');
  for(const [coordinate,allowed] of Object.entries(readers)){
    const match=/^(npub1[a-z0-9]+)\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(coordinate);
    if(!match||match[2]==='..')throw Error('invalid_repository_coordinate');
    let owner:string;
    try {const d=nip19.decode(match[1]);if(d.type!=='npub'||nip19.npubEncode(d.data)!==match[1])throw Error();owner=d.data;}catch{throw Error('invalid_repository_owner');}
    const members=keys(allowed);
    if(!members.length||!members.includes(owner)||members.some(k=>!v.git.members.includes(k)))throw Error('repository_reader_outside_members');
  }
  if(v.git.maintainers.some((k:string)=>!v.git.members.includes(k)))throw Error('maintainer_outside_members');
  if(v.relay.enabled&&(!v.relay.origin||!v.relay.publishers.length))throw Error('relay_configuration_required');
  if(v.blossom.enabled&&(!v.blossom.origin||!v.blossom.publisher))throw Error('blossom_configuration_required');
  if(v.git.enabled&&(!v.git.origin||!v.git.members.length||!v.git.maintainers.length||!Object.keys(readers).length))throw Error('git_configuration_required');
  const origins=[v.relay.origin,v.blossom.origin,v.git.origin].filter(Boolean).map((x:string)=>x.replace(/^wss:/,'https:').replace(/^ws:/,'http:'));
  if(new Set(origins).size!==origins.length)throw Error('module_origins_must_be_separate');
  return structuredClone(v) as ModuleSettings;
}
/** Environment contains only public metadata; graph secrets require the protected
 * runtime integration and must never be returned from public settings/status. */
export function moduleEnvironment(value:ModuleSettings):Record<string,string> {
  const m=validateModuleSettings(value);
  return {GRAPH_ENABLED:String(m.graph.enabled),NSTACK_RELAY_ENABLED:String(m.relay.enabled),NSTACK_RELAY_PUBLIC_ORIGIN:m.relay.enabled?m.relay.origin:'',NSTACK_RELAY_HEALTH_URL:m.relay.enabled?'http://nstack-module-relay:8080/':'',NSTACK_BLOSSOM_ENABLED:String(m.blossom.enabled),NSTACK_BLOSSOM_PUBLIC_ORIGIN:m.blossom.enabled?m.blossom.origin:'',NSTACK_BLOSSOM_HEALTH_URL:m.blossom.enabled?'http://nstack-module-blossom:3000/':'',NSTACK_GRASP_ENABLED:String(m.git.enabled),NSTACK_GRASP_PUBLIC_ORIGIN:m.git.enabled?m.git.origin:'',NSTACK_GRASP_HEALTH_URL:m.git.enabled?'http://nstack-module-git:7334/':''};
}
