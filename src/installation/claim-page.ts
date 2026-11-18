/** Standalone setup page: no native dialogs or client-held signing keys. */
export function installationHtml() {
 return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Set up NStack</title>
<style>body{font:18px system-ui;max-width:700px;margin:8vh auto;padding:24px;background:#101923;color:#eee}input,button{font:inherit;padding:12px;max-width:100%;box-sizing:border-box}input{width:100%}button{margin:16px 0}a{color:#98d3ff}pre{white-space:pre-wrap;overflow-wrap:anywhere}[hidden]{display:none!important}</style>
<h1>Welcome to NStack</h1><p>Claim this installation with your Nostr signer and the one-time code from your local Docker installation. This makes you the instance administrator. Workspace permissions remain separate.</p>
<label>Local claim code<input id="code" type="password" autocomplete="off"></label><button id="claim" disabled>Connect signer and claim</button>
<section id="review" hidden aria-label="Review administrator identity"><h2>Confirm administrator</h2><p>Make this public Nostr identity the administrator of this installation? Check it matches your intended signer.</p><pre id="identity"></pre><button id="approve">Confirm identity and claim</button></section>
<button id="cancel" hidden>Cancel</button><button id="retry" hidden>Check status and retry</button><p id="status" role="status" aria-live="polite">Checking installation…</p><pre id="readiness"></pre><a href="/ui">Open NStack</a>
<script type="module">
const el=id=>document.getElementById(id),status=el('status');
let generation=0,ready=false,busy=false,reviewed=null,submitted=false;
const message=e=>e instanceof Error?e.message:String(e);
function reset(){busy=false;reviewed=null;el('review').hidden=true;el('cancel').hidden=true;el('claim').disabled=!ready;el('code').disabled=false;}
function closed(){ready=false;reset();el('code').value='';el('retry').hidden=true;status.textContent='Installation already claimed or managed by environment settings. Use the existing administrator identity.';}
async function bounded(work,label,ms=45000){let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out. Dismiss any old signer request before retrying.')),ms);})]);}finally{clearTimeout(timer);}}
async function readState(){const r=await fetch('/api/v4/installation/status',{cache:'no-store',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Could not check installation status ('+r.status+').');return r.json();}
async function check(){el('retry').hidden=true;el('claim').disabled=true;status.textContent='Checking installation…';try{const state=await readState();el('readiness').textContent='FIPS: '+state.fips.requirement+'\\nHTTPS: '+(state.https.configured?'configured':'optional, not configured');if(!state.claim_available){closed();return;}ready=true;submitted=false;reset();status.textContent='Ready. Enter the local code and connect your signer.';}catch(e){ready=false;reset();status.textContent=message(e);el('retry').hidden=false;}}
el('retry').onclick=()=>{if(!busy)check();};
el('cancel').onclick=()=>{if(submitted)return;generation++;reset();status.textContent='Cancelled. No claim was sent. Dismiss any pending signer request before retrying.';};
el('claim').onclick=async()=>{
 if(busy||!ready)return;
 if(!el('code').value.trim()){status.textContent='Enter the local claim code first.';return;}
 const turn=++generation;busy=true;submitted=false;el('claim').disabled=true;el('code').disabled=true;el('cancel').hidden=false;status.textContent='Connecting to your Nostr signer… Approve the connection in your signer.';
 try{
  const signer=window.nostr;
  if(!signer?.getPublicKey||!signer?.signEvent)throw Error('Connect a Nostr browser signer, then retry.');
  const pubkey=await bounded(Promise.resolve().then(()=>signer.getPublicKey()),'Signer connection');
  if(turn!==generation)return;
  if(typeof pubkey!=='string'||!(/^[a-f0-9]{64}$/i).test(pubkey))throw Error('Signer returned an invalid public identity.');
  reviewed={pubkey:pubkey.toLowerCase(),signer,body:JSON.stringify({code:el('code').value.trim()})};
  el('identity').textContent=reviewed.pubkey;el('review').hidden=false;el('approve').disabled=false;status.textContent='Review the identity below, then explicitly confirm to claim.';
 }catch(e){if(turn!==generation)return;generation++;reset();status.textContent=message(e);}
};
el('approve').onclick=async()=>{
 if(!busy||!reviewed||submitted||el('approve').disabled)return;
 el('approve').disabled=true;const turn=generation;const {pubkey,signer,body}=reviewed;
 status.textContent='Preparing the signed claim…';
 try{
  if(!crypto.subtle)throw Error('Secure signing is unavailable. Open the local loopback setup URL or HTTPS.');
  const bytes=await bounded(crypto.subtle.digest('SHA-256',new TextEncoder().encode(body)),'Claim preparation');
  if(turn!==generation)return;
  const hash=Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
  const url=new URL('/api/v4/installation/claim',location.origin).href;
  status.textContent='Waiting for your signer to approve signing… You can cancel before the claim is sent.';
  const event=await bounded(Promise.resolve().then(()=>signer.signEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',url],['method','POST'],['payload',hash]],content:''})),'Signer approval');
  if(turn!==generation)return;
  if(event?.pubkey!==pubkey)throw Error('Signer identity changed. Reconnect and review the identity again.');
  submitted=true;el('cancel').hidden=true;status.textContent='Submitting claim… Checking the result before allowing another attempt.';
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Nostr '+btoa(JSON.stringify(event))},body,signal:AbortSignal.timeout(15000)});
  const result=await r.json();if(!r.ok)throw Error(result.error||'Claim request failed ('+r.status+').');
  ready=false;reset();el('code').value='';status.textContent='Installation claimed. Open NStack to create your workspace.';
 }catch(e){
  if(turn!==generation)return;
  generation++;
  // A lost HTTP reply is uncertain delivery: do not offer another write until
  // authoritative status confirms that claiming is still open.
  if(submitted){ready=false;reset();status.textContent=message(e)+' Check installation status before retrying; the claim may have succeeded.';el('retry').hidden=false;}
  else{reset();status.textContent=message(e);}
 }
};
check();
</script></html>`;
}
