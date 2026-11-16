import {getEffectiveRequestUrl} from '../auth';
import {signConnectionChallenge} from '../services/workspace-connection';
import {controllerStore} from '../installation/controller-store';
import {readInstallationSettings,validateInstallationSettings,installationEnvironmentLocks} from '../installation/settings';
import { bodyLimit } from 'hono/body-limit';
import { Hono } from 'hono';
import { config } from '../config';
import { verifyNip98Auth } from '../auth';
import { claimInstallation, installedAdmin } from '../installation/state';

export const installationRouter = new Hono();
const directory = () => process.env.NSTACK_SETUP_DIRECTORY;

installationRouter.get('/status', (c) => c.json({
  version: 1,
  claim_available: Boolean(directory() && !installedAdmin() && !process.env.ADMIN_NPUB),
  claimed: Boolean(config.adminNpub),
  fips: { desired_enabled: process.env.NSTACK_FIPS_DESIRED !== 'false', runtime: 'not_verified',
    requirement: 'A persistent Linux/macOS host FIPS daemon, pinned peer and ingress are required. Configuration alone is not readiness.' },
  https: { configured: Boolean(config.directHttpsUrl) },
}));
installationRouter.post('/claim', bodyLimit({maxSize:1024,onError:(c)=>c.json({error:'claim_payload_too_large'},413)}), async (c) => {
  const dir = directory();
  if (!dir || process.env.ADMIN_NPUB || installedAdmin()) return c.json({error:'claim_closed'},409);
  if (Number(c.req.header('content-length') || 0) > 1024) return c.json({error:'claim_payload_too_large'},413);
  const raw = await c.req.raw.clone().text();
  if (raw.length > 1024) return c.json({error:'claim_payload_too_large'},413);
  const signer = await verifyNip98Auth(c.req.raw);
  if (!signer) return c.json({error:'nip98_auth_required'},401);
  let body;
  try { body=JSON.parse(raw); } catch { return c.json({error:'invalid_json'},400); }
  if (typeof body.code !== 'string' || !await claimInstallation(dir,body.code,signer)) {
    return c.json({error:'claim_invalid_or_closed'},409);
  }
  config.adminNpub = signer;
  return c.json({claimed:true,admin_npub:signer},201);
});

export function installationHtml() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Set up NStack</title>
<style>body{font:18px system-ui;max-width:700px;margin:8vh auto;padding:24px;background:#101923;color:#eee}input,button{font:inherit;padding:12px;max-width:100%;box-sizing:border-box}input{width:100%}button{margin:16px 0}a{color:#98d3ff}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h1>Welcome to NStack</h1><p>Claim this installation with your Nostr signer and the one-time code from your local Docker installation. This makes you the instance administrator. Workspace permissions remain separate.</p>
<label>Local claim code<input id="code" type="password" autocomplete="off"></label><button id="claim">Connect signer and claim</button><p id="status" role="status"></p><pre id="readiness"></pre><a href="/ui">Open NStack</a>
<script type="module">
const status=document.querySelector('#status');
const response=await fetch('/api/v4/installation/status');const state=await response.json();
document.querySelector('#readiness').textContent='FIPS: '+state.fips.requirement+'\\nHTTPS: '+(state.https.configured?'configured':'optional, not configured');
if(!state.claim_available){document.querySelector('#claim').disabled=true;status.textContent='Installation already claimed or managed by environment settings.';}
document.querySelector('#claim').onclick=async()=>{try{
if(!window.nostr)throw Error('Connect a Nostr browser signer to continue.');
const pubkey=await window.nostr.getPublicKey();
if(!confirm('Make the identity with public key '+pubkey+' the administrator of this installation?'))return;
const body=JSON.stringify({code:document.querySelector('#code').value.trim()});
const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body));
const hash=Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
const url=new URL('/api/v4/installation/claim',location.origin).href;
const event=await window.nostr.signEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',url],['method','POST'],['payload',hash]],content:''});
const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Nostr '+btoa(JSON.stringify(event))},body});
const result=await r.json();if(!r.ok)throw Error(result.error);
document.querySelector('#code').value='';status.textContent='Installation claimed. Open NStack to create your workspace.';document.querySelector('#claim').disabled=true;
}catch(e){status.textContent=e.message;}};
</script></html>`;
}

installationRouter.get('/settings',async(c)=>{
 const signer=await verifyNip98Auth(c.req.raw);if(!signer)return c.json({error:'nip98_auth_required'},401);
 if(signer!==config.adminNpub)return c.json({error:'admin_required'},403);
 const dir=process.env.NSTACK_SETTINGS_DIRECTORY;if(!dir)return c.json({error:'controller_not_configured'},409);
 const store=controllerStore(dir);let operation;try{operation=store.latest();}finally{store.close();}
 return c.json({settings:readInstallationSettings(dir),locked:installationEnvironmentLocks,operation,interruption:'Applying these settings restarts only this installation’s Tower API. Existing connections will disconnect briefly.',
  modules:{graph:'not_enabled',relay:'not_enabled',blossom:'not_enabled',git:'not_enabled'},
  reachability:{local:'ready',https:config.directHttpsUrl?'configured_not_verified':'not_configured',fips:'host_daemon_and_mesh_not_verified'}});
});
installationRouter.post('/settings/apply',bodyLimit({maxSize:2048,onError:c=>c.json({error:'settings_too_large'},413)}),async(c)=>{
 const signer=await verifyNip98Auth(c.req.raw);if(!signer)return c.json({error:'nip98_auth_required'},401);
 if(signer!==config.adminNpub)return c.json({error:'admin_required'},403);
 const dir=process.env.NSTACK_SETTINGS_DIRECTORY;if(!dir)return c.json({error:'controller_not_configured'},409);
 let desired;try{desired=validateInstallationSettings(await c.req.json());}catch{return c.json({error:'invalid_settings'},400);}
 const current=readInstallationSettings(dir);
 for(const field of ['https_origin','fips_desired','fips'] as const)if(installationEnvironmentLocks[field]&&JSON.stringify(desired[field])!==JSON.stringify(current[field]))return c.json({error:'setting_locked_by_environment',field},409);
 // Fixed catalogue only: no arbitrary commands, images, paths, credentials or service names.
 const token=c.req.header('authorization')!.slice(6).trim();
 const eventId=JSON.parse(Buffer.from(token,'base64').toString('utf8')).id;
 const store=controllerStore(dir);
 try{return c.json(store.enqueue(eventId,desired),202);}
 catch(e){return c.json({error:(e as Error).message},409);}
 finally{store.close();}
});

installationRouter.get('/identity-proof',(c)=>{
 const nonce=c.req.query('nonce')||'';if(!/^[a-f0-9]{64}$/.test(nonce))return c.json({error:'invalid_nonce'},400);
 c.header('Cache-Control','no-store');
 return c.json({proof:signConnectionChallenge({nonce,service_npub:config.service.npub,request_url:getEffectiveRequestUrl(c.req.raw).href,expires_at:Math.floor(Date.now()/1000)+60},config.service.nsec)});
});

installationRouter.post('/settings/recover',bodyLimit({maxSize:1024,onError:c=>c.json({error:'settings_too_large'},413)}),async(c)=>{
 const signer=await verifyNip98Auth(c.req.raw);if(!signer)return c.json({error:'nip98_auth_required'},401);
 if(signer!==config.adminNpub)return c.json({error:'admin_required'},403);
 const dir=process.env.NSTACK_SETTINGS_DIRECTORY;if(!dir)return c.json({error:'controller_not_configured'},409);
 const token=c.req.header('authorization')!.slice(6).trim();const eventId=JSON.parse(Buffer.from(token,'base64').toString('utf8')).id;
 const store=controllerStore(dir);try{return c.json(store.enqueue(eventId,readInstallationSettings(dir),true),202);}
 catch(e){return c.json({error:(e as Error).message},409);}finally{store.close();}
});
