import {test,expect} from 'bun:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {runControllerOperation,atomicJson,type ControllerOperation} from '../src/installation/controller';
import {defaultSettings,validateInstallationSettings} from '../src/installation/settings';
test('controller verifies apply and rolls back failed or interrupted changes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nstack-controller-'));
 try{
 let restarts=0;const operation:ControllerOperation={id:'test',state:'pending',desired:{...defaultSettings,https_origin:'https://nstack.example'}};
 await runControllerOperation(dir,operation,{restart:async()=>{restarts++},verify:async()=>true});expect(operation.state).toBe('committed');expect(restarts).toBe(1);
 const failed:ControllerOperation={id:'fail',state:'pending',desired:{...defaultSettings,https_origin:'https://wrong.example'}};
 let checks=0;await runControllerOperation(dir,failed,{restart:async()=>{restarts++},verify:async()=>++checks>1});expect(failed.state).toBe('rolled_back');
 expect(JSON.parse(await readFile(join(dir,'settings.json'),'utf8')).https_origin).toBe('https://nstack.example');
 const interrupted:ControllerOperation={id:'interrupted',state:'verifying',desired:defaultSettings,previous:operation.desired};
 await atomicJson(join(dir,'settings.json'),defaultSettings);
 await runControllerOperation(dir,interrupted,{restart:async()=>{},verify:async()=>true});expect(interrupted.state).toBe('rolled_back');
 expect(()=>validateInstallationSettings({...defaultSettings,command:'rm -rf /'})).toThrow();
 expect(()=>validateInstallationSettings({...defaultSettings,https_origin:'https://user:pass@example.com'})).toThrow();
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('durable enqueue deduplicates signed event after completion and survives reopen without stale locks',async()=>{
 const {controllerStore}=await import('../src/installation/controller-store');
 const dir=await mkdtemp(join(tmpdir(),'nstack-enqueue-'));
 try{
  let store=controllerStore(dir);const first=store.enqueue('a'.repeat(64),defaultSettings);expect(first.replayed).toBe(false);
  expect(()=>store.enqueue('b'.repeat(64),defaultSettings)).toThrow();
  store.save({...first.operation,state:'committed'});store.close();
  store=controllerStore(dir);const replay=store.enqueue('a'.repeat(64),defaultSettings);expect(replay.replayed).toBe(true);expect(replay.operation.state).toBe('committed');
  const next=store.enqueue('c'.repeat(64),defaultSettings);store.save({...next.operation,state:'recovery_required',previous:defaultSettings});
  const recovery=store.enqueue('d'.repeat(64),defaultSettings,true);expect(recovery.operation.state).toBe('applying');
  store.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});
