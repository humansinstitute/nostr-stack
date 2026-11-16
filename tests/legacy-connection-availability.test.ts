import {test,expect} from 'bun:test';
import {generateSecretKey,getPublicKey,nip19,finalizeEvent} from 'nostr-tools';
import {config} from '../src/config';import {createApp} from '../src/server';

test('FIPS-only install refuses legacy v2 token generation after administrator authentication',async()=>{
 const prior={admin:config.adminNpub,https:config.directHttpsUrl};const key=generateSecretKey();
 try{
  config.adminNpub=nip19.npubEncode(getPublicKey(key));config.directHttpsUrl='';const app=createApp();
  const url='http://localhost/api/v4/admin/workspaces/00000000-0000-4000-8000-000000000001/connection-token?app_npub='+config.adminNpub;
  expect((await app.fetch(new Request(url))).status).toBe(401);
  const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',url],['method','GET']],content:''},key);
  const response=await app.fetch(new Request(url,{headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64')}}));
  expect(response.status).toBe(409);const result=await response.json();expect(result.code).toBe('legacy_connection_requires_https');expect(result.connection_token).toBeUndefined();
 }finally{config.adminNpub=prior.admin;config.directHttpsUrl=prior.https;}
});
