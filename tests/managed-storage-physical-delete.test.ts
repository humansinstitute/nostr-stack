import {test,expect} from 'bun:test';
import {getPublicKey,nip19} from 'nostr-tools';
for(const k of ['DB_USER','DB_PASSWORD','GRAPH_DB_ADMIN_USER','GRAPH_DB_ADMIN_PASSWORD','GRAPH_DB_APP_USER','GRAPH_DB_APP_PASSWORD','STORAGE_S3_ACCESS_KEY','STORAGE_S3_SECRET_KEY'])process.env[k]='disposable-only';
process.env.SUPERBASED_DIRECT_HTTPS_URL='https://fixture.invalid';process.env.STORAGE_S3_ENDPOINT_PUBLIC='https://objects.invalid';
for(const k of ['ADMIN_NPUB','FLIGHT_DECK_PG_APP_NPUB'])process.env[k]=nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(68)));
const {physicalRemover}=await import('../src/managed-storage/physical-delete');
const key=`managed-app-storage/${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}`;
function provider(options:{version?:string;policy?:string;head?:number;deleteMarker?:boolean;toggle?:boolean;denyDelete?:boolean}={}){
 let checks=0,deletes=0;const calls:string[]=[];
 const client:any={send:async(command:any)=>{const name=command.constructor.name;calls.push(name);
  expect(command.input.Bucket).toBeDefined();if(name!=='GetBucketVersioningCommand')expect(command.input.Key).toBe(key);
  if(name==='GetBucketVersioningCommand'){checks++;return {$metadata:{httpStatusCode:200},Status:options.version??(options.toggle&&checks>1?'Enabled':undefined)};}
  if(name==='DeleteObjectCommand'){deletes++;if(options.denyDelete)throw {$metadata:{httpStatusCode:403}};return {$metadata:{httpStatusCode:204},DeleteMarker:options.deleteMarker};}
  if(options.head===200)return {$metadata:{httpStatusCode:200}};throw {$metadata:{httpStatusCode:options.head??404}};
 }};
 return {remove:physicalRemover(client,()=>options.policy??'never-versioned-exclusive-writer'),calls,deletes:()=>deletes};
}
test('physical deletion requires never-versioned policy, exact namespace, DELETE204 and true HEAD404 then second version check',async()=>{
 const p=provider();await p.remove(key,AbortSignal.timeout(1000));expect(p.calls).toEqual(['GetBucketVersioningCommand','DeleteObjectCommand','HeadObjectCommand','GetBucketVersioningCommand']);
 await expect(p.remove('v4/someone-else',AbortSignal.timeout(1000))).rejects.toMatchObject({code:'storage_physical_key_invalid'});
 const no=provider({policy:'unset'});await expect(no.remove(key,AbortSignal.timeout(1000))).rejects.toMatchObject({code:'storage_physical_policy_required'});expect(no.calls).toHaveLength(0);
 for(const version of ['Enabled','Suspended']){const v=provider({version});await expect(v.remove(key,AbortSignal.timeout(1000))).rejects.toMatchObject({code:'storage_versioned_delete_unsupported'});expect(v.deletes()).toBe(0);}
});
test('logical delete marker, denied/retained object, unknown HEAD and versioning race never confirm physical absence',async()=>{
 for(const opts of [{deleteMarker:true},{head:200},{head:403},{head:500},{denyDelete:true},{toggle:true}]){
  const p=provider(opts);await expect(p.remove(key,AbortSignal.timeout(1000))).rejects.toBeDefined();
 }
});
