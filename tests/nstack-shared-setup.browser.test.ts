import {test,expect} from 'bun:test';
import {chromium} from 'playwright';
import {createHash} from 'node:crypto';
import {generateSecretKey,getPublicKey,nip19,finalizeEvent,verifyEvent} from 'nostr-tools';
import {buildNstackConsoleHtml,consoleAsset} from '../src/nstack-console';

test('fresh-install console creates shared UUID workspace only after explicit signed review without NIP44',async()=>{
 const key=generateSecretKey(),pubkey=getPublicKey(key),npub=nip19.npubEncode(pubkey),workspace='00000000-0000-4000-8000-000000000001';
 let created=false;const writes:any[]=[];
 const server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){
  const url=new URL(req.url),path=url.pathname;if(path==='/ui')return new Response(buildNstackConsoleHtml(url.origin,{defaultWorkspaceModel:'typed'}),{headers:{'content-type':'text/html'}});
  if(path.startsWith('/ui/assets/')){const asset=consoleAsset(path.split('/').at(-1)!);return asset?new Response(asset):new Response('',{status:404});}
  const event=JSON.parse(Buffer.from(req.headers.get('authorization')!.slice(6),'base64').toString());expect(verifyEvent(event)).toBe(true);expect(event.pubkey).toBe(pubkey);
  if(req.method==='POST'){
   const raw=await req.text();expect(event.tags).toContainEqual(['payload',createHash('sha256').update(raw).digest('hex')]);const body=JSON.parse(raw);writes.push({path,body});
   if(path==='/api/v4/admin/flightdeck-pg/workspaces'){created=true;return Response.json({workspace_id:workspace});}
   return Response.json({error:'Unexpected mutation'},{status:400});
  }
  if(path==='/api/v4/flightdeck-pg/workspaces')return Response.json({workspaces:created?[{identity:{workspace_id:workspace,workspace_owner_npub:npub,workspace_service_npub:npub,app_npub:npub},label:'First shared workspace'}]:[]});
  if(path==='/api/v4/workspaces')return Response.json({workspaces:[]});
  if(path.endsWith('/storage/metadata'))return Response.json({objects:[],total:0});
  if(path.endsWith('/storage-usage'))return Response.json({categories:[]});
  return Response.json({namespaces:[],app_namespaces:[]});
 }});
 const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage();await page.exposeFunction('fixtureSign',e=>finalizeEvent(e as any,key));
  await page.addInitScript(pubkey=>{(window as any).nostr={getPublicKey:async()=>pubkey,signEvent:(e:any)=>(window as any).fixtureSign(e)};},pubkey);
  await page.goto('http://127.0.0.1:'+server.port+'/ui');await page.getByRole('button',{name:'Connect with Nostr'}).click();
  await page.locator('#newWorkspace').click();expect(await page.locator('#workspaceModel').inputValue()).toBe('typed');await page.locator('#newName').fill('First shared workspace');
  await page.locator('#setupForm button[type=submit]').click();expect(writes).toHaveLength(0);await page.locator('#approveReview').click();
  await page.waitForFunction(()=>document.getElementById('workspaceName')?.textContent==='First shared workspace');
  expect(writes).toEqual([{path:'/api/v4/admin/flightdeck-pg/workspaces',body:{workspace_name:'First shared workspace',workspace_description:'',creator_npub:npub}}]);
  expect(await page.getByRole('button',{name:'Connect to this workspace · QR'}).count()).toBe(1);
 }finally{await browser.close();server.stop(true);}
},30000);
