import {test,expect} from 'bun:test';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeInstallation} from '../src/installation/bootstrap';
import {claimInstallation,installedAdmin} from '../src/installation/state';
import {generateSecretKey,getPublicKey,nip19} from 'nostr-tools';

test('bootstrap persists credentials and exactly one claim wins across concurrent writers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nstack-bootstrap-'));
 try{
  await Promise.all(Array.from({length:8},()=>initializeInstallation(dir)));
  const before=await readFile(join(dir,'bootstrap.json'),'utf8');
  await initializeInstallation(dir);
  expect(await readFile(join(dir,'bootstrap.json'),'utf8')).toBe(before);
  expect((await stat(join(dir,'bootstrap.json'))).mode&0o777).toBe(0o600);
  const state=JSON.parse(before);const signers=Array.from({length:8},()=>nip19.npubEncode(getPublicKey(generateSecretKey())));
  expect(await claimInstallation(dir,'0'.repeat(48),signers[0])).toBe(false);
  const winners=await Promise.all(signers.map(s=>claimInstallation(dir,state.claim_code,s)));
  expect(winners.filter(Boolean)).toHaveLength(1);
  expect(installedAdmin(dir)).toBe(signers[winners.indexOf(true)]);
  expect(await claimInstallation(dir,state.claim_code,signers[0])).toBe(false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
