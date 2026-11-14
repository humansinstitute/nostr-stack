/** Ordinary agent Git/review workflow. No token printing, credential files or local keys. */
import {resolve} from 'node:path';
import {GraspClient,nostr} from '../../lib/grasp/client';
const [action,root,directory,...args]=process.argv.slice(2);
if(!['clone','fetch','refs','push','review-list','review-create'].includes(action)||!root||!directory)throw Error('Use clone|fetch|refs|push|review-list|review-create ROOT DIRECTORY [BRANCH BASE TITLE BODYFILE]');
const client=new GraspClient(root),cwd=resolve(directory),owner=nostr.nip19.decode(client.coordinate.actor).data;
if(action==='clone'){console.log(await client.git(['clone','--',root,cwd],process.cwd()));}
if(action==='fetch'){console.log(await client.git(['fetch','--no-write-fetch-head',root,'+refs/heads/*:refs/remotes/grasp/*','+refs/tags/*:refs/tags/*'],cwd));}
if(action==='refs')console.log(await client.git(['ls-remote','--symref',root],cwd));
if(action==='review-list')console.log(JSON.stringify(await client.query({kinds:[1618],'#a':[`30617:${owner}:${client.coordinate.identifier}`]}),null,2));
if(action==='push'||action==='review-create'){
 const branch=args[0];if(!branch||branch.startsWith('-'))throw Error('An explicit local branch is required');
 await client.git(['check-ref-format','refs/heads/'+branch],cwd,false);
 const oid=await client.git(['rev-parse','--verify',`refs/heads/${branch}^{commit}`],cwd,false);
 const advertised=await client.git(['ls-remote','--refs',root],cwd);
 const refs=advertised.split('\n').filter(Boolean).map(l=>{const [oid,ref]=l.split(/\s+/);return {oid,ref};});
 const remoteBranch=refs.find(r=>r.ref==='refs/heads/'+branch);
 if(action==='push'){
  // Ordinary pushes retain every advertised ref and require a fast-forward.
  // Never provide force, delete, mirror or arbitrary refspec escape hatches.
  if(remoteBranch){await client.git(['fetch','--no-tags',root,remoteBranch.ref],cwd);await client.git(['merge-base','--is-ancestor',remoteBranch.oid,oid],cwd,false);remoteBranch.oid=oid;}
  else refs.push({oid,ref:'refs/heads/'+branch});
  const latest=await client.git(['ls-remote','--refs',root],cwd);if(latest!==advertised)throw Error('Concurrent remote update; fetch and retry');
  const event=await client.sign({kind:30618,content:'',tags:[['d',client.coordinate.identifier],['HEAD','ref: refs/heads/main'],...refs.map(r=>[r.ref,r.oid])]});
  await client.publish(event);
  await client.git(['push','--porcelain',root,`${oid}:refs/heads/${branch}`],cwd);
  const after=await client.git(['ls-remote','--refs',root,'refs/heads/'+branch],cwd);if(!after.startsWith(oid+'\t'))throw Error('Push readback mismatch');
  console.log(`Pushed and read back ${branch} at ${oid}`);
 }else{
  if(!remoteBranch||remoteBranch.oid!==oid)throw Error('Push the review branch before creating its PR');
  const [baseName,title,bodyFile]=args.slice(1);if(!baseName||!title||!bodyFile)throw Error('Review requires BRANCH BASE TITLE BODYFILE');
  await client.git(['check-ref-format','refs/heads/'+baseName],cwd,false);
  const base=refs.find(r=>r.ref==='refs/heads/'+baseName);if(!base)throw Error('Base branch is not advertised');
  const roots=(await client.git(['rev-list','--max-parents=0',oid],cwd,false)).split('\n');
  const content=await Bun.file(bodyFile).text();
  const e=await client.sign({kind:1618,content,tags:[['a',`30617:${owner}:${client.coordinate.identifier}`,client.relay],['p',String(owner)],['r',roots[0]],['c',oid],['clone',root],['merge-base',base.oid],['branch-name',branch],['subject',title],['alt','git Pull Request: '+title]]});
  await client.publish(e);
  if(!(await client.query({ids:[e.id]})).some(x=>x.id===e.id))throw Error('PR readback missing');
  console.log(`PR published and read back: ${e.id}`);
 }
}
