// Explicit opt-in disposable container only. Never uses configured provider credentials or endpoints.
import {spawnSync} from 'node:child_process';
import {getPublicKey,nip19} from 'nostr-tools';
import {S3Client,CreateBucketCommand,PutObjectCommand,HeadObjectCommand,PutBucketVersioningCommand,DeleteObjectCommand,ListObjectVersionsCommand} from '@aws-sdk/client-s3';
function command(args:string[]){const r=spawnSync('docker',args,{encoding:'utf8'});if(r.status!==0)throw Error('Disposable docker fixture command failed');return r.stdout.trim();}
const name='nstack-delete-fixture-'+crypto.randomUUID(),access='disposablefixture',secret='disposablefixturepassword';
let container:string|undefined;
try{
 container=command(['run','--rm','-d','--name',name,'-p','127.0.0.1::9000','-e','MINIO_ROOT_USER='+access,'-e','MINIO_ROOT_PASSWORD='+secret,'minio/minio:latest','server','/data']);
 const port=command(['port',container,'9000/tcp']).split(':').at(-1)!;
 const endpoint='http://127.0.0.1:'+port,bucket='disposable-backup-delete';
 const sdk=new S3Client({region:'us-east-1',endpoint,forcePathStyle:true,maxAttempts:1,credentials:{accessKeyId:access,secretAccessKey:secret}});
 for(let i=0;i<100;i++){try{if((await fetch(endpoint+'/minio/health/live')).ok)break;}catch{}await Bun.sleep(50);}
 for(const k of ['DB_USER','DB_PASSWORD','GRAPH_DB_ADMIN_USER','GRAPH_DB_ADMIN_PASSWORD','GRAPH_DB_APP_USER','GRAPH_DB_APP_PASSWORD'])process.env[k]='disposable-only';
 process.env.STORAGE_S3_ACCESS_KEY=access;process.env.STORAGE_S3_SECRET_KEY=secret;process.env.STORAGE_S3_ENDPOINT=endpoint;process.env.STORAGE_S3_ENDPOINT_PUBLIC=endpoint;process.env.STORAGE_S3_BUCKET=bucket;
 process.env.SUPERBASED_DIRECT_HTTPS_URL='https://fixture.invalid';
 for(const k of ['ADMIN_NPUB','FLIGHT_DECK_PG_APP_NPUB'])process.env[k]=nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(72)));
 const {physicalRemover}=await import('../src/managed-storage/physical-delete');
 const remove=physicalRemover(sdk,()=> 'never-versioned-exclusive-writer');
 await sdk.send(new CreateBucketCommand({Bucket:bucket}));
 const key=`managed-app-storage/${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}`;
 await sdk.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:new TextEncoder().encode('disposable archive')}));
 await remove(key,AbortSignal.timeout(10000));
 let absent=false;try{await sdk.send(new HeadObjectCommand({Bucket:bucket,Key:key}));}catch(e:any){absent=e?.$metadata?.httpStatusCode===404;}
 if(!absent)throw Error('Native physical absence not confirmed');
 await sdk.send(new PutBucketVersioningCommand({Bucket:bucket,VersioningConfiguration:{Status:'Enabled'}}));
 await sdk.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:new TextEncoder().encode('versioned disposable archive')}));
 await sdk.send(new DeleteObjectCommand({Bucket:bucket,Key:key}));
 const versions=await sdk.send(new ListObjectVersionsCommand({Bucket:bucket,Prefix:key}));
 if(versions.Versions?.length!==1||versions.DeleteMarkers?.length!==1)throw Error('Native marker semantics missing');
 for(const status of ['Enabled','Suspended'] as const){
  if(status==='Suspended')await sdk.send(new PutBucketVersioningCommand({Bucket:bucket,VersioningConfiguration:{Status:status}}));
  let refused=false;try{await remove(key,AbortSignal.timeout(10000));}catch(e:any){refused=e.code==='storage_versioned_delete_unsupported';}
  if(!refused)throw Error('Native versioning gate failed');
 }
 console.log(JSON.stringify({disposable_minio:true,never_versioned_physical_absent:true,delete_marker_retains_prior_version:true,enabled_refused:true,suspended_refused:true,existing_remote_data_touched:false}));
 sdk.destroy();
}finally{if(container)command(['rm','-f',container]);}
