import {test,expect} from 'bun:test';
import {nip19} from 'nostr-tools';
import {fipsPeerAddress,validateHostFipsStatus,classifyHostFipsProbe,installationFipsRoutes,INSTALLATION_FIPS_SERVICES} from '../src/installation/host-fips';
import {createFipsHostGateway} from '../src/fips-host-gateway';
const peer=nip19.npubEncode('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
test('host identity uses authoritative peer-derived FIPS address vector',()=>{
 expect(fipsPeerAddress(peer)).toBe('fd13:2f39:a98c:31ba:addb:a652:5f5d:43f2');
 expect(validateHostFipsStatus({npub:peer,ipv6_addr:fipsPeerAddress(peer),persistent:true,state:'running',tun_state:'active'},'darwin').state).toBe('ready');
 for(const change of [{persistent:false},{tun_state:'inactive'},{ipv6_addr:'fd00::1'}])expect(validateHostFipsStatus({npub:peer,ipv6_addr:fipsPeerAddress(peer),persistent:true,state:'running',tun_state:'active',...change},'linux').state).toBe('not_ready');
 expect(()=>createFipsHostGateway(12345 as any)).toThrow();
 expect(Object.keys(INSTALLATION_FIPS_SERVICES)).toEqual(['tower','relay','blossom','git']);
});

test('missing host is installable; stopped, denied or existing-uninspectable hosts never reinstall',()=>{
 expect(classifyHostFipsProbe({platform:'linux',binaryPresent:false,existingState:false}).state).toBe('install_required');
 expect(classifyHostFipsProbe({platform:'darwin',binaryPresent:false,existingState:true}).state).toBe('not_ready');
 expect(classifyHostFipsProbe({platform:'linux',binaryPresent:true,existingState:true,exitCode:1}).state).toBe('not_ready');
 const payload={npub:peer,ipv6_addr:fipsPeerAddress(peer),persistent:true,state:'running',tun_state:'active'};
 expect(classifyHostFipsProbe({platform:'linux',binaryPresent:true,existingState:true,exitCode:0,payload}).state).toBe('ready');
});
test('per-service FIPS routes are independent of optional HTTPS primary origins',()=>{
 const status=validateHostFipsStatus({npub:peer,ipv6_addr:fipsPeerAddress(peer),persistent:true,state:'running',tun_state:'active'},'linux');
 const settings={fips_desired:true,fips:{peer_npub:peer,mesh_address:fipsPeerAddress(peer),port:43110},modules:{relay:{enabled:true,origin:'wss://relay.example'},blossom:{enabled:true,origin:`http://${peer}.fips:43113`},git:{enabled:true,origin:'https://git.example'}}};
 expect(installationFipsRoutes(settings,status)).toEqual([{service:'tower',port:43110},{service:'relay',port:43112},{service:'blossom',port:43113},{service:'git',port:43114}]);
 expect(installationFipsRoutes({...settings,fips_desired:false},status)).toEqual([]);
 expect(()=>installationFipsRoutes({...settings,fips_service_ports:{git:43110}},status)).toThrow();
});

test('OS exit success alone is not readiness, awaiting operations can be rechecked',async()=>{
 const {hostInstallationCompletion}=await import('../src/installation/host-fips');
 const {hostOperations}=await import('../src/installation/host-state');
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const notReady=classifyHostFipsProbe({platform:'linux',binaryPresent:false,existingState:false});
 expect(hostInstallationCompletion(0,notReady)).toBe('awaiting_os_authorization');expect(hostInstallationCompletion(1,notReady)).toBe('failed');
 expect(hostInstallationCompletion(0,{state:'ready',platform:'linux'})).toBe('complete');
 const dir=await mkdtemp(join(tmpdir(),'nstack-host-op-'));try{
  const store=hostOperations(dir);const op=store.enqueue('a'.repeat(64));store.save({...op,state:'awaiting_os_authorization'});store.close();
  const reopened=hostOperations(dir);expect(reopened.next()?.state).toBe('awaiting_os_authorization');reopened.save({...op,state:'complete'});expect(reopened.next()).toBeNull();reopened.save({...op,state:'running'});expect(reopened.enqueue(op.id).state).toBe('complete');reopened.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});
