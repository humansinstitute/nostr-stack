import { afterAll, expect, test } from 'bun:test';
import { createECDH, randomBytes } from 'node:crypto';
import { classifyUnifiedPushResult, endpointUrl, loadUnifiedPushConfig, parseUnifiedPushInput, publicAddress, resolveEndpoint } from '../src/services/notification-unifiedpush';
import { transportAdvertisement } from '../src/services/notification-registry';
const names = ['UNIFIEDPUSH_VAPID_PUBLIC_KEY','UNIFIEDPUSH_VAPID_PRIVATE_KEY','UNIFIEDPUSH_VAPID_SUBJECT','UNIFIEDPUSH_ALLOWED_ORIGINS'];
const saved = names.map(n => process.env[n]);
afterAll(() => names.forEach((n,i) => { if(saved[i] === undefined) delete process.env[n]; else process.env[n] = saved[i]; }));
const ec = createECDH('prime256v1'); ec.generateKeys();
const body = () => ({ endpoint: 'https://push.example/secret', keys: { p256dh: ec.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } });
function configure() { Object.assign(process.env, { UNIFIEDPUSH_VAPID_PUBLIC_KEY: ec.getPublicKey().toString('base64url'), UNIFIEDPUSH_VAPID_PRIVATE_KEY: ec.getPrivateKey().toString('base64url'), UNIFIEDPUSH_VAPID_SUBJECT: 'mailto:operator@example.com', UNIFIEDPUSH_ALLOWED_ORIGINS: 'https://push.example' }); }
test('independent honest readiness and validated keypair', () => {
  names.forEach(n => delete process.env[n]); expect(loadUnifiedPushConfig().ready).toBe(false);
  configure(); expect(loadUnifiedPushConfig().ready).toBe(true);
  expect(transportAdvertisement().transport_status.unifiedpush.vapid_public_key).toBe(ec.getPublicKey().toString('base64url'));
  process.env.UNIFIEDPUSH_VAPID_PRIVATE_KEY = randomBytes(32).toString('base64url'); expect(loadUnifiedPushConfig().ready).toBe(false);
});
test('registration accepts only canonical RFC8291 keys and generic bounded lease', () => {
  configure(); expect(parseUnifiedPushInput(body()).lease_seconds).toBe(604800);
  expect(parseUnifiedPushInput({...body(),endpoint:'https://PUSH.example:443/secret'}).endpoint).toBe('https://push.example/secret');
  for (const change of [{preview:'full'}, {lease_seconds:0}, {keys:{p256dh:'bad',auth:'bad'}}, {keys:{...body().keys,auth:randomBytes(15).toString('base64url')}}, {keys:{...body().keys,p256dh:Buffer.alloc(65).toString('base64url')}}, {keys:{...body().keys,extra:'x'}}]) expect(() => parseUnifiedPushInput({...body(),...change})).toThrow();
});
test('exact origin HTTPS URL limits and no credential/fragment/IP escape', () => {
  const origins = new Set(['https://push.example','https://127.0.0.1','https://[::1]']);
  for (const value of ['http://push.example/x','https://push.example.evil/x','https://u:p@push.example/x','https://push.example/x#','https://push.example/x#y','https://127.0.0.1/x','https://[::1]/x','https://push.example:444/x',`https://push.example/${'é'.repeat(500)}`]) expect(() => endpointUrl(value,origins)).toThrow();
});
test('public DNS only, mixed answers rejected, fresh resolution on every call', async () => {
  for(const ip of ['127.0.0.1','10.2.3.4','172.16.0.1','192.168.0.1','169.254.169.254','100.64.0.1','192.0.2.4','198.51.100.1','203.0.113.1','224.0.0.1','::1','::ffff:8.8.8.8','fc00::1','fe80::1','2001:db8::1','2002:808:808::1','2001:20::1','3fff::1']) expect(publicAddress(ip)).toBe(false);
  expect(publicAddress('8.8.8.8')).toBe(true); expect(publicAddress('2001:4860:4860::8888')).toBe(true);
  let count = 0; const resolver: any = async () => { count++; return [{address:count === 1 ? '8.8.8.8':'127.0.0.1',family:4}]; };
  const origins = new Set(['https://push.example']);
  expect((await resolveEndpoint('https://push.example/x',origins,resolver)).address.address).toBe('8.8.8.8');
  await expect(resolveEndpoint('https://push.example/x',origins,resolver)).rejects.toThrow(); expect(count).toBe(2);
  await expect(resolveEndpoint('https://push.example/x',origins,(async () => [{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]) as any)).rejects.toThrow();
});
test('provider result classification excludes redirect and isolates stale/retry/credential failures', () => {
  for(const status of [200,201,204]) expect(classifyUnifiedPushResult(status)).toBe('sent');
  for(const status of [404,410]) expect(classifyUnifiedPushResult(status)).toBe('stale_token');
  for(const status of [429,500,503,0]) expect(classifyUnifiedPushResult(status)).toBe('transient');
  for(const status of [401,403]) expect(classifyUnifiedPushResult(status)).toBe('credential');
  for(const status of [301,302,307,400,413]) expect(classifyUnifiedPushResult(status)).toBe('permanent');
});

test('sender encrypts and pins direct TLS with original verified hostname and no redirect/proxy', async () => {
  const { sendUnifiedPush } = await import('../src/services/notification-unifiedpush');
  const { EventEmitter } = await import('node:events');
  configure(); const state = loadUnifiedPushConfig(); if(!state.ready) throw Error('config');
  let captured: any; const writes: any[] = []; let connects=0;
  const connect: any = (options: any, ready: any) => {
    connects++; captured=options;
    const socket: any = new EventEmitter(); socket.destroy = () => socket;
    socket.write = (bytes: any) => { writes.push(bytes); if(writes.length===2) socket.emit('data',Buffer.from('HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1/private\r\n\r\nPRIVATE_PROVIDER_BODY')); };
    queueMicrotask(ready); return socket;
  };
  const result = await sendUnifiedPush(state.config,{...body(),body:'PRIVATE_PAYLOAD',expiration:Math.floor(Date.now()/1000)+60},{connect,resolver:(async()=>[{address:'8.8.8.8',family:4}]) as any});
  expect(result.status).toBe(307); expect(connects).toBe(1);
  expect(captured).toMatchObject({host:'8.8.8.8',port:443,servername:'push.example',rejectUnauthorized:true,ALPNProtocols:['http/1.1']});
  expect(writes[0]).toStartWith('POST /secret HTTP/1.1'); expect(writes[0]).toContain('Host: push.example');
  expect(writes[0]).toContain('Content-Encoding: aes128gcm'); expect(writes[0]).toContain('Authorization: vapid ');
  expect(Buffer.from(writes[1]).toString()).not.toContain('PRIVATE_PAYLOAD');
});
