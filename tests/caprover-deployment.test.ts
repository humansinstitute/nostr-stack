import {describe,expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
const entrypoint=readFileSync(new URL('../docker/entrypoint.sh',import.meta.url),'utf8');
const apiEnv=readFileSync(new URL('../caprover/tower-api.env.example',import.meta.url),'utf8');
describe('CapRover GRasp retirement boundary',()=>{
 test('legacy Git roles fail closed before any DB or network operation',()=>{
  for(const role of ['git-gateway','git-issue-broker','git-identity-reconciler','git-org-reconciler','git-reconciler']){
   const p=Bun.spawnSync(['sh','docker/entrypoint.sh'],{env:{...process.env,TOWER_RUNTIME_ROLE:role}});expect(p.exitCode).toBe(64);expect(p.stderr.toString()).toContain('Retired runtime role');
  }
  expect(entrypoint).not.toContain('exec bun run git:gateway');
 });
 test('API configuration retains Tower identity and has no Forgejo authentication',()=>{
  expect(apiEnv).toContain('TOWER_RUNTIME_ROLE=api');expect(apiEnv).toContain('FLIGHT_DECK_PG_APP_NPUB=REPLACE_WITH_FLIGHT_DECK_APP_NPUB');expect(apiEnv).not.toContain('GIT_OIDC_');expect(apiEnv).not.toContain('GIT_FORGEJO_');
 });
});
