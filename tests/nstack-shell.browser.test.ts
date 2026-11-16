import {test,expect} from 'bun:test';
import {chromium} from 'playwright';
import {generateSecretKey,getPublicKey,nip19,finalizeEvent,verifyEvent} from 'nostr-tools';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {signWorkspaceConnection,type WorkspaceConnectionV3} from '../src/services/workspace-connection';

test('packaged shell retains exact native capability, proves identity and selects only scanned UUID',async()=>{
 const service=generateSecretKey(),user=generateSecretKey(),other=generateSecretKey();
 const npub=nip19.npubEncode(getPublicKey(service)),userHex=getPublicKey(user),userNpub=nip19.npubEncode(userHex),appNpub=nip19.npubEncode(getPublicKey(other));
 const payload:WorkspaceConnectionV3={type:'nstack-workspace',version:3,service_npub:npub,workspace_id:'00000000-0000-4000-8000-000000000001',workspace_service_npub:npub,name:'Exact scanned workspace',transports:{https:{url:'https://unrelated.example'},fips:{peer_npub:npub,host:npub+'.fips',port:43110}},policy:{preferred:'fips',fallback:'none'}};
 const endpoint='http://'+npub+'.fips:43110',envelope=signWorkspaceConnection(payload,nip19.nsecEncode(service));
 const bundle=await mkdtemp(join(tmpdir(),'nstack-shell-'));
 const build=Bun.spawn([process.execPath,'scripts/build-nstack-shell.ts',bundle],{stdout:'pipe',stderr:'pipe'});expect(await build.exited).toBe(0);
 const manifest=JSON.parse(await readFile(join(bundle,'manifest.json'),'utf8'));
 const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch(req){
  const path=new URL(req.url).pathname;if(!path.startsWith('/cap/'))return new Response('',{status:403});
  const file=path.slice('/cap/'.length),entry=manifest.files[file];if(!entry)return new Response('',{status:404});
  return new Response(Bun.file(join(bundle,file)),{headers:{'content-type':entry.contentType,'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src https:; frame-src 'none'; worker-src 'none'; base-uri 'none'; object-src 'none'"}});
 }});
 const browser=await chromium.launch({headless:true});
 try{
  for(const scenario of ['good','wrong-proof','missing-provider','https']){
   const context=await browser.newContext();const page=await context.newPage();const requests:string[]=[],grants:any[]=[];let ambient=0;const selectedEndpoint=scenario==='https'?payload.transports.https!.url:endpoint;
   let nativeDialogs=0;page.on('dialog',dialog=>{nativeDialogs++;return dialog.dismiss();});
   await page.route('**/*.fips*/**',route=>{ambient++;return route.abort();});
   await page.exposeFunction('fixtureSign',event=>finalizeEvent(event as any,user));
   await page.exposeFunction('fixtureConnect',grant=>{grants.push(grant);});
   const respond=(input:any)=>{
    const url=new URL(input.url);expect(url.origin).toBe(selectedEndpoint);requests.push(url.pathname);
    const event=JSON.parse(Buffer.from((input.headers.Authorization||input.headers.authorization).replace('Nostr ',''),'base64').toString());expect(verifyEvent(event)).toBe(true);expect(event.pubkey).toBe(userHex);expect(event.tags).toContainEqual(['u',input.url]);
    let result:any={};
    if(url.pathname.endsWith('/connection-proof'))result={proof:finalizeEvent({kind:30384,created_at:Math.floor(Date.now()/1000),tags:[['d','nstack-connection-challenge-v1']],content:JSON.stringify({nonce:url.searchParams.get('nonce'),service_npub:npub,workspace_id:payload.workspace_id,workspace_service_npub:npub,request_url:input.url,expires_at:Math.floor(Date.now()/1000)+60})},scenario==='wrong-proof'?other:service)};
    else if(url.pathname==='/api/v4/flightdeck-pg/workspaces')result={workspaces:[{identity:{workspace_id:'00000000-0000-4000-8000-000000000002',workspace_owner_npub:userNpub,workspace_service_npub:npub,app_npub:appNpub},label:'Wrong first workspace'},{identity:{workspace_id:payload.workspace_id,workspace_owner_npub:userNpub,workspace_service_npub:npub,app_npub:appNpub},label:payload.name}]};
    else if(url.pathname==='/api/v4/workspaces')result={workspaces:[]};
    else if(url.pathname.endsWith('/storage/metadata'))result={objects:[],total:0};
    else if(url.pathname.endsWith('/storage-usage'))result={categories:[],total_description:'Fixture'};
    else if(url.pathname.endsWith('/namespace-inventory'))result={namespaces:[],app_namespaces:[]};
    return {status:200,body:JSON.stringify(result)};
   };
   await page.exposeFunction('fixtureNativeFetch',respond);
   await page.route('https://unrelated.example/**',async route=>{
    if(scenario!=='https'){ambient++;await route.abort();return;}
    const headers={'access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,PUT,PATCH,DELETE'};
    if(route.request().method()==='OPTIONS'){await route.fulfill({status:204,headers});return;}
    const result=respond({url:route.request().url(),headers:route.request().headers()});await route.fulfill({...result,headers:{...headers,'content-type':'application/json'}});
   });
   await page.addInitScript(({userHex,available})=>{
    let signerPending=false;
    (window as any).signerOverlaps=0;
    (window as any).nostr={getPublicKey:async()=>userHex,signEvent:async(event:any)=>{
     // Native approval is interactive: another request cannot enter while it is open.
     if(signerPending){(window as any).signerOverlaps++;throw Error('Another authentication approval is pending.');}
     signerPending=true;
     try{await new Promise(resolve=>setTimeout(resolve,30));return await (window as any).fixtureSign(event);}
     finally{signerPending=false;}
    }};
    (window as any).fipsTransport={available,version:2,connect:async(input:any)=>{await (window as any).fixtureConnect(input);return {...input,fetch:async(url:string,init:any)=>{const result=await (window as any).fixtureNativeFetch({url,headers:init.headers});return new Response(result.body,{status:result.status,headers:{'content-type':'application/json'}});},disconnect:async()=>{}};}};
   },{userHex,available:scenario!=='missing-provider'});
   await page.goto('http://127.0.0.1:'+server.port+'/cap/index.html');expect(await page.evaluate(()=>typeof (window as any).Buffer)).toBe('undefined');
   await page.getByLabel('Shared workspace connection',{exact:true}).fill(envelope);await page.getByRole('button',{name:'Preview connection',exact:true}).click();await page.getByRole('button',{name:scenario==='https'?'Use HTTPS':'Use FIPS',exact:true}).click();
   expect(requests).toHaveLength(0);expect(grants).toHaveLength(0);
   await page.locator('#cancelReview').click();expect(requests).toHaveLength(0);
   await page.getByRole('button',{name:scenario==='https'?'Use HTTPS':'Use FIPS',exact:true}).click();await page.locator('#approveReview').click();
   if(scenario==='good'||scenario==='https'){
    await page.waitForFunction(name=>document.getElementById('workspaceName')?.textContent===name,payload.name);expect(await page.locator('#workspaceName').textContent()).toBe(payload.name);
    expect(grants).toEqual(scenario==='https'?[]:[{endpoint,peerNpub:npub,purpose:'tower'}]);expect(requests).toContain('/api/v4/flightdeck-pg/workspaces');
   }else{
    const message=scenario==='missing-provider'?'native FIPS transport':'identity proof invalid';await page.waitForFunction(message=>document.getElementById('status')?.textContent?.includes(message),message);expect(await page.locator('#status').textContent()).toContain(message);
    expect(requests.includes('/api/v4/flightdeck-pg/workspaces')).toBe(false);
   }
   expect(await page.evaluate(()=>(window as any).signerOverlaps)).toBe(0);
   expect(ambient).toBe(0);expect(nativeDialogs).toBe(0);await context.close();
  }
 }finally{await browser.close();server.stop(true);await rm(bundle,{recursive:true,force:true});}
},30000);
