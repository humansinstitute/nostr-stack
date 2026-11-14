import {boundedBrokerRetry} from './retry';
import {Client,broker,nostr,check} from './transport';
import {validateSignedResponse} from './signed-response';
export {nostr};
export function coordinates(root:string){
 const u=new URL(root);
 check(!u.username&&!u.password&&!u.search&&!u.hash,'Credentials and query forbidden');
 check(u.protocol==='https:'||(u.protocol==='http:'&&/^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}\.fips$/.test(u.hostname)&&u.port!==''),'HTTPS or pinned FIPS origin required');
 const match=u.pathname.match(/^\/(npub1[023456789acdefghjklmnpqrstuvwxyz]{58})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\.git$/);
 check(match,'Canonical actor/repository Git root required');
 check(nostr.nip19.decode(match[1]).type==='npub','Invalid actor');
 return {root:u.href,relay:u.origin.replace(/^http/,'ws')+'/',actor:match[1],identifier:match[2]};
}
export class GraspClient extends Client {
 readonly coordinate:ReturnType<typeof coordinates>;
 constructor(root:string){const c=coordinates(root);super(c.root,c.relay);this.coordinate=c;}
 async sign(template:{kind:number;content:string;tags:string[][];created_at?:number}){
  const identity=await broker.readCapabilityIdentity();
  if([30617,30618].includes(template.kind))check(identity.botNpub===this.coordinate.actor,'Publisher must own coordinate');
  check([22242,30617,30618,1617,1618,1621,1630,1631,1632,1633].includes(template.kind),'Unsupported repository event');
  if(template.kind===22242)check(template.tags.some(t=>t[0]==='relay'&&t[1]===this.relay),'Authentication relay mismatch');
  else if([30617,30618].includes(template.kind))check(template.tags.some(t=>t[0]==='d'&&t[1]===this.coordinate.identifier),'Repository coordinate mismatch');
  else check(template.tags.some(t=>t[0]==='a'&&t[1]===`30617:${nostr.nip19.decode(this.coordinate.actor).data}:${this.coordinate.identifier}`),'Review coordinate mismatch');
  return boundedBrokerRetry(async()=>{
   const e={...template,created_at:Math.floor(Date.now()/1000),pubkey:identity.botPubkeyHex};
   const r:any=await broker.callCapabilityBroker('/api/mcp/capabilities/nostr-event',{event:e});
   validateSignedResponse(r.event,e,nostr.verifyEvent);return r.event;
  });
 }
 async credential(){
  const identity=await broker.readCapabilityIdentity();
  return boundedBrokerRetry(async()=>{
  const requestedAt=Math.floor(Date.now()/1000);
  const r:any=await broker.callCapabilityBroker('/api/mcp/capabilities/nip98',{url:this.root,method:'GET'});
  check(r.signedBy===identity.botNpub&&r.token?.startsWith('Nostr '),'Unexpected HTTP signer');
  const event=JSON.parse(Buffer.from(r.token.slice(6),'base64').toString());
  validateSignedResponse(event,{kind:27235,content:'',created_at:requestedAt,pubkey:identity.botPubkeyHex,tags:[['u',this.root],['method','GET']]},nostr.verifyEvent,process.env.SESSION_ID);
  return r.token as string;
  });
 }
 async publish(event:any){const {s,auth}=await this.authenticate(e=>this.sign(e));try{check(auth[2]===true,'Member authentication denied');s.send(['EVENT',event]);const ack=await s.next();check(ack[0]==='OK'&&ack[1]===event.id&&ack[2]===true,'Event publication denied');return ack;}finally{s.close();}}
 async query(filter:object){return this.events(e=>this.sign(e),filter);}
 async git(args:string[],cwd:string,authenticated=true){
  const env={...process.env};for(const k of Object.keys(env))if(/^(GIT_|NGIT_|WINGMAN_|AUTOPILOT_|SESSION_ID$)|proxy/i.test(k))delete env[k];
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_COUNT:authenticated?'5':'4',GIT_CONFIG_KEY_0:'http.followRedirects',GIT_CONFIG_VALUE_0:'false',GIT_CONFIG_KEY_1:'credential.helper',GIT_CONFIG_VALUE_1:'',GIT_CONFIG_KEY_2:'core.hooksPath',GIT_CONFIG_VALUE_2:'/dev/null',GIT_CONFIG_KEY_3:'http.proxy',GIT_CONFIG_VALUE_3:''});
  if(authenticated)Object.assign(env,{GIT_CONFIG_KEY_4:`http.${this.root}.extraHeader`,GIT_CONFIG_VALUE_4:'Authorization: '+await this.credential()});
  const p=Bun.spawn(['git',...args],{cwd,env,stdin:'ignore',stdout:'pipe',stderr:'pipe'});const timeout=setTimeout(()=>p.kill(),55000);
  const [out,,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);clearTimeout(timeout);
  check(code===0,`Git ${args[0]} failed (${code}); credential-bearing output withheld`);return out.trim();
 }
}
