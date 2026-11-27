import { test, expect } from 'bun:test';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, nip19 } from 'nostr-tools';
import { createHash } from 'node:crypto';
import { buildNstackConsoleHtml, consoleAsset } from '../src/nstack-console';

test('owner permission UI: explicit review, readback, revoke, stale revision, scope and signer fencing', async () => {
  const secret = generateSecretKey(), pubkey = getPublicKey(secret), owner = nip19.npubEncode(pubkey);
  const app = nip19.npubEncode(getPublicKey(generateSecretKey())), agent = nip19.npubEncode(getPublicKey(generateSecretKey()));
  const foreign = nip19.npubEncode(getPublicKey(generateSecretKey()));
  let grants: any[] = [], stale = false, pauseSign = false, releaseSign: (()=>void) | undefined;
  const writes: any[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/ui') return new Response(buildNstackConsoleHtml(new URL(req.url).origin), { headers: {'content-type':'text/html'} });
    if (path.startsWith('/ui/assets/')) { const f = consoleAsset(path.split('/').pop()!); return f ? new Response(f) : new Response('',{status:404}); }
    const raw = req.method === 'GET' ? '' : await req.text(), body = raw ? JSON.parse(raw) : null;
    const event = JSON.parse(Buffer.from((req.headers.get('authorization') || '').replace('Nostr ',''),'base64').toString());
    expect(verifyEvent(event)).toBe(true); expect(event.pubkey).toBe(pubkey); expect(event.tags).toContainEqual(['u',req.url]); expect(event.tags).toContainEqual(['method',req.method]);
    if (raw) expect(event.tags).toContainEqual(['payload',createHash('sha256').update(raw).digest('hex')]);
    if (path === '/api/v4/workspaces') return Response.json({workspaces:[]});
    if (path === '/api/v4/flightdeck-pg/workspaces') return Response.json({workspaces:[owner,foreign].map((o,i)=>({identity:{workspace_id:'typed-'+i,workspace_owner_npub:o,workspace_service_npub:app,app_npub:app},label:i?'Other namespace':'Owner workspace'}))});
    if (path.endsWith('/app-permissions')) {
      if (path.includes(foreign)) return Response.json({error:'Only the namespace owner may view, grant or revoke agent app permissions'},{status:403});
      if (req.method === 'GET') {
        if (new URL(req.url).searchParams.has('before')) return Response.json({grants:[{...grants[0],id:'earlier',app_npub:foreign,expires_at:new Date(Date.now()-1000).toISOString()}]});
        return Response.json({grants,truncated:grants.length>0,next_cursor:grants.length?'earlier':null});
      }
      writes.push({path,body}); const grant = {id:body.idempotency_key,...body,revision:1,created_by_npub:owner,revoked_at:null}; grants.push(grant); return Response.json({grant},{status:201});
    }
    if (path.endsWith('/revoke')) {
      if (stale) return Response.json({error:'Permission changed. Refresh and review its current revision'},{status:409});
      writes.push({path,body}); grants[0].revoked_at=new Date().toISOString(); grants[0].revision++; return Response.json({grant:grants[0]});
    }
    if (path.endsWith('/storage-usage')) return Response.json({categories:[]});
    return Response.json({error:'Not available in fixture'},{status:403});
  }});
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.exposeFunction('fixtureSign', async (event:any) => { if (pauseSign && event.tags.some((t:any)=>t[0]==='method'&&t[1]==='POST')) await new Promise<void>(r=>{releaseSign=r;}); return finalizeEvent(event,secret); });
    await page.addInitScript(({pubkey}) => { (window as any).nostr={getPublicKey:async()=>pubkey,signEvent:(e:any)=>(window as any).fixtureSign(e)}; },{pubkey});
    await page.goto(server.url+'ui'); await page.locator('#connect').click();
    await page.waitForFunction(()=>document.getElementById('status')!.textContent!.startsWith('Viewing'));
    await page.getByRole('button',{name:'Agent app permissions',exact:true}).click();
    await page.locator('#permissionForm').waitFor({state:'visible'});
    expect(await page.locator('#permissionScope').textContent()).toContain(owner);
    await page.locator('#permissionAgent').fill(agent); await page.locator('#permissionApp').fill(app);
    const expiry = new Date(Date.now()+86400000); const local = new Date(expiry.getTime()-expiry.getTimezoneOffset()*60000).toISOString().slice(0,16);
    await page.locator('#permissionExpiry').fill(local);
    await page.getByRole('button',{name:'Review permission',exact:true}).click();
    expect(writes).toHaveLength(0); expect(await page.locator('#reviewBody').textContent()).toContain('onward delegation'); expect(await page.locator('#reviewBody').textContent()).toContain(agent);
    await page.locator('#cancelReview').click(); expect(writes).toHaveLength(0);
    await page.getByRole('button',{name:'Review permission',exact:true}).click(); await page.locator('#approveReview').click();
    await page.getByText('Active permission',{exact:true}).waitFor(); expect(writes).toHaveLength(1); expect(writes[0].body.permission).toBe('namespace.manage');
    if (process.env.CONSOLE_SCREENSHOT_DIR) await page.screenshot({path:process.env.CONSOLE_SCREENSHOT_DIR+'/permissions-desktop.png',fullPage:true});
    await page.getByRole('button',{name:'Load earlier permissions',exact:true}).click(); await page.getByText('Expired',{exact:true}).waitFor(); expect(await page.locator('#permissionList').textContent()).toContain(foreign);
    stale=true; await page.getByRole('button',{name:'Revoke permission',exact:true}).click(); await page.locator('#approveReview').click();
    await page.locator('#reviewError').filter({hasText:'Permission changed'}).waitFor(); expect(writes).toHaveLength(1); await page.locator('#cancelReview').click();
    stale=false; await page.getByRole('button',{name:'Revoke permission',exact:true}).click(); await page.locator('#approveReview').click();
    await page.getByText('Revoked',{exact:true}).waitFor(); expect(writes[1].body.expected_revision).toBe(1);
    await page.locator('#workspace').selectOption('typed:typed-1'); await page.locator('#permissionAccess').filter({hasText:'Only the namespace owner'}).waitFor(); expect(await page.locator('#permissionForm').isHidden()).toBe(true); expect(await page.locator('#permissionList').textContent()).not.toContain(agent);
    await page.locator('#workspace').selectOption('typed:typed-0'); await page.locator('#permissionForm').waitFor({state:'visible'});
    await page.locator('#permissionAgent').fill(agent); await page.locator('#permissionApp').fill(app); await page.locator('#permissionExpiry').fill(local);
    await page.getByRole('button',{name:'Review permission',exact:true}).click(); pauseSign=true; await page.locator('#approveReview').click();
    await page.waitForTimeout(100); expect(releaseSign).toBeTruthy();
    await page.evaluate(()=>{const select=document.getElementById('workspace') as HTMLSelectElement;select.value='typed:typed-1';select.dispatchEvent(new Event('change'));});
    releaseSign!(); await page.waitForTimeout(100); expect(writes).toHaveLength(2);
    await page.setViewportSize({width:390,height:844}); expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.CONSOLE_SCREENSHOT_DIR) await page.screenshot({path:process.env.CONSOLE_SCREENSHOT_DIR+'/permissions-mobile.png',fullPage:true});
  } finally { releaseSign?.(); await browser.close(); server.stop(true); }
},30000);
