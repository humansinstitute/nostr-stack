import { afterAll, beforeEach, expect, test } from 'bun:test';
import { generateKeyPairSync, verify } from 'node:crypto';
import { buildFcmPayload, classifyFcmResult, fcmAccessToken, FCM_TOKEN_URL, loadFcmConfig, parseFcmInput, resetFcmOAuthCache, sendFcm, FcmAuthError } from '../src/services/notification-fcm';
import { transportAdvertisement } from '../src/services/notification-registry';
const names = ['FCM_SERVICE_ACCOUNT_JSON','FCM_SERVICE_ACCOUNT_JSON_FILE','FCM_PROJECT_ID','FCM_SENDER_ID','FCM_ANDROID_PACKAGE','NOTIF_PUBLIC_ORIGIN'];
const saved = names.map(n=>process.env[n]);
const keys = generateKeyPairSync('rsa',{modulusLength:2048});
const account = {type:'service_account',project_id:'test-project',client_email:['sender','test-project.iam.gserviceaccount.com'].join('@'),private_key:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),token_uri:FCM_TOKEN_URL};
function configure() { delete process.env.FCM_SERVICE_ACCOUNT_JSON_FILE; Object.assign(process.env,{FCM_SERVICE_ACCOUNT_JSON:JSON.stringify(account),FCM_PROJECT_ID:'test-project',FCM_SENDER_ID:'123456789',FCM_ANDROID_PACKAGE:'studio.example.test',NOTIF_PUBLIC_ORIGIN:'https://tower.example'}); }
function config() { const s=loadFcmConfig();if(!s.ready)throw Error(s.reason);return s.config; }
const registration = () => ({device_token:'device-token-value-123456',project_id:'test-project',sender_id:'123456789',package_name:'studio.example.test'});
const input = () => ({token:'PRIVATE_DEVICE_TOKEN',installationId:'installation',expiration:1700000060,collapseId:'opaque',content:{workspaceId:'workspace',itemId:'item',changeSeq:1,sourceAppId:'flightdeck.core',category:'mention',threadId:'opaque',coreSource:true,ids:{task_id:'PRIVATE_TASK'},badge:2,origin:'https://tower.example',towerServiceNpub:'tower',preview:{title:'PRIVATE_TITLE',body:'PRIVATE_BODY'}}});
beforeEach(()=>{configure();resetFcmOAuthCache();});
afterAll(()=>names.forEach((n,i)=>{if(saved[i]===undefined)delete process.env[n];else process.env[n]=saved[i];}));
test('readiness fails closed, rejects alternate OAuth host/key/project, descriptor is public metadata only',()=>{
  delete process.env.FCM_SERVICE_ACCOUNT_JSON;expect(loadFcmConfig()).toEqual({ready:false,reason:'fcm_not_configured'});
  configure();expect(transportAdvertisement().transport_status.fcm).toMatchObject({ready:true,project_id:'test-project',sender_id:'123456789',package_name:'studio.example.test'});
  expect(JSON.stringify(transportAdvertisement())).not.toContain('PRIVATE');
  for(const change of [{token_uri:'https://evil.example/token'},{project_id:'other-project'},{private_key:'invalid'},{type:'authorized_user'}]){process.env.FCM_SERVICE_ACCOUNT_JSON=JSON.stringify({...account,...change});expect(loadFcmConfig().ready).toBe(false);}
  configure();process.env.FCM_SERVICE_ACCOUNT_JSON_FILE='/nonexistent';expect(loadFcmConfig().ready).toBe(false);
});
test('registration matches project sender package and validates token/lease/generic preview',()=>{
  expect(parseFcmInput(registration()).lease_seconds).toBe(604800);
  for(const change of [{project_id:'other-project'},{sender_id:'9999999'},{package_name:'other.app'},{preview:'full'},{lease_seconds:0},{lease_seconds:2592001},{device_token:'x\nsecret'}])expect(()=>parseFcmInput({...registration(),...change})).toThrow();
});
test('generic visible notification plus minimal string hint uses agreed channel/action and deadline',()=>{
  const payload=buildFcmPayload(config(),input(),1700000000000);
  expect(payload.message.android).toMatchObject({restricted_package_name:'studio.example.test',ttl:'60s',notification:{channel_id:'workspace_activity_v1',click_action:'studio.otherstuff.ambulando.PUSH_TAP',tag:'installation:workspace:item'}});
  expect(JSON.parse(payload.message.data.fd)).toEqual({v:1,installation_id:'installation',origin:'https://tower.example',tower_service_npub:'tower',workspace_id:'workspace',notification_id:'item',change_seq:1});
  const text=JSON.stringify(payload); for(const s of ['PRIVATE_TITLE','PRIVATE_BODY','PRIVATE_TASK'])expect(text).not.toContain(s);
  expect(payload.message.notification.title).toBe('You were mentioned');
});
test('OAuth signs fixed audience/scope, coalesces and caches until safe TTL then refreshes',async()=>{
  let count=0;const now=1700000000000;
  const request:any=async(url:string,options:any)=>{count++;expect(url).toBe(FCM_TOKEN_URL);expect(options.redirect).toBe('error');
    const jwt=options.body.get('assertion').split('.');expect(verify('RSA-SHA256',Buffer.from(jwt.slice(0,2).join('.')),keys.publicKey,Buffer.from(jwt[2],'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(jwt[1],'base64url').toString())).toMatchObject({aud:FCM_TOKEN_URL,scope:'https://www.googleapis.com/auth/firebase.messaging',iat:1700000000,exp:1700003600});
    return Response.json({access_token:'mock-token',token_type:'Bearer',expires_in:3600});};
  await Promise.all([fcmAccessToken(config(),request,now),fcmAccessToken(config(),request,now)]);expect(count).toBe(1);
  await fcmAccessToken(config(),request,now+3539000);expect(count).toBe(1);
  // New request verifies its own issuance time separately.
  await fcmAccessToken(config(),(async()=>{count++;return Response.json({access_token:'refreshed',token_type:'Bearer',expires_in:3600});}) as any,now+3540000);expect(count).toBe(2);
});
test('OAuth does not cache malformed TTL, treats auth rejection as credentials and 503 as transient',async()=>{
  for(const expires_in of [0,60,3601,'3600'])await expect(fcmAccessToken(config(),(async()=>Response.json({access_token:'mock',token_type:'Bearer',expires_in})) as any)).rejects.toBeInstanceOf(FcmAuthError);
  try{await fcmAccessToken(config(),(async()=>Response.json({error:'PRIVATE'},{status:403})) as any);}catch(e){expect((e as FcmAuthError).credential).toBe(true);expect(String(e)).not.toContain('PRIVATE');}
  try{await fcmAccessToken(config(),(async()=>Response.json({error:'PRIVATE'},{status:503})) as any);}catch(e){expect((e as FcmAuthError).credential).toBe(false);}
});
test('HTTP v1 fixed endpoint, bearer auth, sanitized typed error only, Retry-After',async()=>{
  const seen:string[]=[];const request:any=async(url:string,opts:any)=>{seen.push(url);expect(opts.redirect).toBe('error');if(url===FCM_TOKEN_URL)return Response.json({access_token:'mock-token',token_type:'Bearer',expires_in:3600});expect(opts.headers.authorization).toBe('Bearer mock-token');return Response.json({error:{message:'PRIVATE_TOKEN',details:[{'@type':'type.googleapis.com/google.firebase.fcm.v1.FcmError',errorCode:'UNREGISTERED'}]}},{status:404,headers:{'retry-after':'120'}});};
  const result=await sendFcm(config(),input(),request);expect(seen).toEqual([FCM_TOKEN_URL,'https://fcm.googleapis.com/v1/projects/test-project/messages:send']);expect(result).toEqual({status:404,code:'UNREGISTERED',retryAfterMs:120000});
});
test('classifier revokes only explicit UNREGISTERED, not generic 404/INVALID_ARGUMENT',()=>{
  const classify=(status:number,code:string|null=null)=>classifyFcmResult({status,code,retryAfterMs:null});
  expect(classify(200)).toBe('sent');expect(classify(404,'UNREGISTERED')).toBe('stale_token');
  for(const [status,code] of [[400,'INVALID_ARGUMENT'],[404,null],[302,null]] as const)expect(classify(status,code)).toBe('permanent');
  for(const status of [0,429,500,503])expect(classify(status)).toBe('transient');
  for(const status of [401,403])expect(classify(status)).toBe('credential');
});
