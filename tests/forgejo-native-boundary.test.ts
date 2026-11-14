import {describe,expect,test} from 'bun:test';
import {createApp} from '../src/server';
import {buildOpenApiDocument} from '../src/openapi';
describe('retired Forgejo integration',()=>{
 test('all former authority and OIDC endpoints are gone without network access',async()=>{
  const app=createApp();
  for(const path of ['repositories','credential-exchanges','internal/capabilities/introspect','oidc/.well-known/openid-configuration','oidc/authorize','oidc/authorize/complete','oidc/token','oidc/userinfo','oidc/jwks'])for(const method of ['GET','POST'])expect((await app.request('/api/v4/git/'+path,{method})).status).toBe(410);
  expect(Object.keys(buildOpenApiDocument('https://tower.example').paths).some(p=>p.startsWith('/api/v4/git/'))).toBe(false);
 });
});
