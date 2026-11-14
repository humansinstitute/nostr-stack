import {describe,test,expect} from 'bun:test';
import {finalizeEvent,generateSecretKey,nip19} from 'nostr-tools';
import {coordinates} from '../lib/grasp/client';
import {validateSignedResponse} from '../lib/grasp/signed-response';
import {verifyEvent} from 'nostr-tools';
const actor=nip19.npubEncode('a'.repeat(64));
const host=nip19.npubEncode('b'.repeat(64))+'.fips:41007';
describe('GRasp private client boundary',()=>{
 test('pins the repository actor in the path and derives exactly one relay',()=>{
  const credentialed=new URL(`http://${host}/${actor}/repository.git`);credentialed.username='fixture';credentialed.password='fixture';
  expect(coordinates(`http://${host}/${actor}/repository.git`)).toEqual({root:`http://${host}/${actor}/repository.git`,relay:`ws://${host}/`,actor,identifier:'repository'});
  for(const root of [`http://public.example/${actor}/repository.git`,`http://${host}/${actor}/../repository.git`,`http://${host}/wrong/repository.git`,credentialed.href,`http://${host}/${actor}/repository.git?redirect=1`,`http://${host}/${actor}/repository.git#fragment`])expect(()=>coordinates(root)).toThrow();
 });
 test('validates the current broker nonce and custody tags without weakening signed URL binding',()=>{
  const key=generateSecretKey(),now=Math.floor(Date.now()/1000),session='11111111-1111-4111-8111-111111111111';
  const tags=[['u',`http://${host}/${actor}/repository.git`],['method','GET']];
  const event=finalizeEvent({kind:27235,content:'',created_at:now,tags:[...tags,['nonce','a'.repeat(32)],['wm-session-capability','22222222-2222-4222-8222-222222222222',session,'b'.repeat(64)]]},key);
  const expected={kind:27235,content:'',created_at:now,pubkey:event.pubkey,tags};
  expect(()=>validateSignedResponse(event,expected,verifyEvent,session)).not.toThrow();
  expect(()=>validateSignedResponse(event,expected,verifyEvent,'different-session')).toThrow();
  expect(()=>validateSignedResponse(event,{...expected,tags:[['u','https://wrong.example/'],['method','GET']]},verifyEvent,session)).toThrow();
  const extra=finalizeEvent({...event,tags:[...event.tags,['nonce','c'.repeat(32)]]},key);
  expect(()=>validateSignedResponse(extra,expected,verifyEvent,session)).toThrow();
 });
});

import {boundedBrokerRetry} from '../lib/grasp/retry';
test('broker retry is bounded and never retries permission denial',async()=>{
 let calls=0;const delays:number[]=[];
 const result=await boundedBrokerRetry(async()=>{if(++calls<3)throw Object.assign(new Error('rate limited'),{name:'CapabilityRateLimitError',retryAfterMs:10});return 'ok';},{sleep:async ms=>{delays.push(ms);}});
 expect(result).toBe('ok');expect(calls).toBe(3);expect(delays).toEqual([110,110]);
 calls=0;await expect(boundedBrokerRetry(async()=>{calls++;throw new Error('permission denied');},{sleep:async()=>{throw Error('must not wait');}})).rejects.toThrow('permission denied');expect(calls).toBe(1);
 calls=0;await expect(boundedBrokerRetry(async()=>{calls++;throw Object.assign(new Error('rate limited'),{name:'CapabilityRateLimitError',retryAfterMs:60000});},{sleep:async()=>{throw Error('must not wait');}})).rejects.toThrow('rate limited');expect(calls).toBe(1);
});
