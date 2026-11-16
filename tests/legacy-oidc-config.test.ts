import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('legacy secret files are read only in the explicit profile and reject ambiguous custody',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tower-oidc-fixture-'));
 const clean={...process.env};for(const n of ['GIT_OIDC_CLIENT_SECRET','GIT_OIDC_SIGNING_KEY','GIT_OIDC_CLIENT_SECRET_FILE','GIT_OIDC_SIGNING_KEY_FILE'])delete clean[n];
 const run=async(extra:Record<string,string>)=>{const child=Bun.spawn(['bun','-e',"const {config}=await import('./src/config'); console.log(JSON.stringify({enabled:config.git.compatibilityEnabled,loaded:config.git.oidcClientSecret==='generated-test-secret'&&config.git.oidcSigningKey==='generated-test-key'}))"],{env:{...clean,...extra},stdout:'pipe',stderr:'pipe'});const [code,out]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {code,result:code===0?JSON.parse(out):null};};
 try {
  expect(await run({NSTACK_LEGACY_FORGEJO_OIDC_ENABLED:'false',GIT_OIDC_CLIENT_SECRET_FILE:join(dir,'absent'),GIT_OIDC_SIGNING_KEY_FILE:join(dir,'absent')})).toEqual({code:0,result:{enabled:false,loaded:false}});
  await writeFile(join(dir,'client'),'generated-test-secret',{mode:0o600});await writeFile(join(dir,'key'),'generated-test-key',{mode:0o600});
  const settings={NSTACK_LEGACY_FORGEJO_OIDC_ENABLED:'true',GIT_OIDC_CLIENT_SECRET_FILE:join(dir,'client'),GIT_OIDC_SIGNING_KEY_FILE:join(dir,'key')};
  expect(await run(settings)).toEqual({code:0,result:{enabled:true,loaded:true}});
  expect((await run({...settings,GIT_OIDC_CLIENT_SECRET:'conflicting-generated-secret'})).code).toBe(1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
