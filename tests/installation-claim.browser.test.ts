import {test,expect} from 'bun:test';
import {chromium} from 'playwright';
import {createHash} from 'node:crypto';
import {finalizeEvent,generateSecretKey,getPublicKey,verifyEvent} from 'nostr-tools';
import {installationHtml} from '../src/installation/claim-page';

// Real rendered Chromium page with a representative asynchronous NIP-07 bridge.
// HTTP authority here is a fixture; live Tower checks are a separate gate.
for(const scenario of ['success','cancel-connect','cancel-sign','rejected','timeout','identity-change','uncertain','status-failure'])test('claim page: '+scenario,async()=>{
 const key=generateSecretKey(),pubkey=getPublicKey(key);let posts=0,claimed=false,statusReads=0;
 const server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){
  const path=new URL(req.url).pathname;
  if(path==='/')return new Response(installationHtml(),{headers:{'content-type':'text/html'}});
  if(path.endsWith('/status')){statusReads++;if(scenario==='status-failure'&&statusReads===1)return Response.json({error:'offline'},{status:503});return Response.json({claim_available:!claimed,fips:{requirement:'host required'},https:{configured:false}});}
  if(path.endsWith('/claim')){posts++;const raw=await req.text(),event=JSON.parse(Buffer.from(req.headers.get('authorization')!.slice(6),'base64').toString());expect(verifyEvent(event)).toBe(true);expect(event.pubkey).toBe(pubkey);expect(event.tags).toContainEqual(['payload',createHash('sha256').update(raw).digest('hex')]);expect(event.tags).toContainEqual(['u',req.url]);expect(event.tags).toContainEqual(['method','POST']);expect(JSON.parse(raw)).toEqual({code:'fixture-code'});claimed=true;if(scenario==='uncertain')return new Response('lost response',{status:502});return Response.json({claimed:true},{status:201});}
  return new Response('',{status:404});
 }});
 const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage();await page.exposeFunction('fixtureSign',(e:any)=>finalizeEvent(e,key));
  await page.addInitScript(({pubkey,scenario})=>{
   (window as any).confirm=()=>{throw Error('native dialog forbidden');};
   (window as any).nostr={getPublicKey:()=>scenario==='cancel-connect'?new Promise(resolve=>{(window as any).release=()=>resolve(pubkey);}):Promise.resolve(pubkey),signEvent:async(e:any)=>{
    if(scenario==='cancel-sign')await new Promise(resolve=>{(window as any).release=resolve;});
    if(scenario==='timeout')return new Promise(()=>{});
    if(scenario==='rejected')throw Error('Signer declined');
    const signed=await (window as any).fixtureSign(e);if(scenario==='identity-change')signed.pubkey='1'.repeat(64);return signed;
   }};
  },{pubkey,scenario});
  await page.goto('http://127.0.0.1:'+server.port);
  if(scenario==='status-failure'){await page.locator('#retry').waitFor({state:'visible'});expect(await page.locator('#claim').isDisabled()).toBe(true);await page.locator('#retry').click();}
  await page.waitForFunction(()=>!(document.getElementById('claim') as HTMLButtonElement).disabled);
  await page.locator('#code').fill('fixture-code');await page.locator('#claim').click();
  if(scenario==='cancel-connect'){expect(await page.locator('#status').textContent()).toContain('Connecting');await page.locator('#cancel').click();await page.evaluate(()=>(window as any).release());await page.waitForTimeout(80);expect(await page.locator('#review').isHidden()).toBe(true);expect(posts).toBe(0);return;}
  await page.locator('#review').waitFor({state:'visible'});expect(await page.locator('#identity').textContent()).toBe(pubkey);expect(posts).toBe(0);
  if(scenario==='timeout')await page.clock.install();
  await page.locator('#approve').click();
  if(scenario==='cancel-sign'){await page.locator('#cancel').click();await page.evaluate(()=>(window as any).release());await page.waitForTimeout(80);expect(posts).toBe(0);expect(await page.locator('#status').textContent()).toContain('No claim was sent');return;}
  if(scenario==='timeout'){await page.clock.fastForward(46000);expect(await page.locator('#status').textContent()).toContain('timed out');expect(posts).toBe(0);expect(await page.locator('#claim').isEnabled()).toBe(true);return;}
  if(['rejected','identity-change'].includes(scenario)){await page.waitForFunction(()=>!(document.getElementById('claim') as HTMLButtonElement).disabled);expect(posts).toBe(0);expect(await page.locator('#status').textContent()).toContain(scenario==='rejected'?'Signer declined':'identity changed');return;}
  if(scenario==='uncertain'){await page.locator('#retry').waitFor({state:'visible'});expect(await page.locator('#claim').isDisabled()).toBe(true);await page.locator('#retry').click();await page.waitForFunction(()=>document.getElementById('status')!.textContent!.includes('already claimed'));}
  else await page.waitForFunction(()=>document.getElementById('status')!.textContent!.includes('Installation claimed.'));
  expect(posts).toBe(1);expect(await page.locator('#claim').isDisabled()).toBe(true);expect(await page.locator('#code').inputValue()).toBe('');
 }finally{await browser.close();server.stop(true);}
},20000);
