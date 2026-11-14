/** Independent populated read/denial checks. Disposable rejection keys never leave memory. */
import {writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {GraspClient,nostr} from '../../lib/grasp/client';
const config=resolve(process.argv[2]),c=await Bun.file(config).json();
if(!config.includes('/tmp/docs/handoffs/'))throw Error('Use ignored evidence config');
const result:any={checked_at:new Date().toISOString(),repositories:[]};
for(const entry of c.repositories){
 const client=new GraspClient(entry.root),token=await client.credential();
 const member=await client.http('/info/refs?service=git-upload-pack',token);
 if(member.status!==200||!member.body.includes(entry.main))throw Error('Member populated read failed');
 const key=nostr.generateSecretKey();
 const event=nostr.finalizeEvent({kind:27235,content:'',created_at:Math.floor(Date.now()/1000),tags:[['u',client.root],['method','GET']]},key);
 const outsider='Nostr '+Buffer.from(JSON.stringify(event)).toString('base64');
 for(const [path,auth,method,body] of [['/info/refs?service=git-upload-pack','',undefined,undefined],['/info/refs?service=git-upload-pack',outsider,undefined,undefined],['/info/refs?service=git-receive-pack',outsider,undefined,undefined],['/git-receive-pack',outsider,'POST','0000']] as const){const r=await client.http(path,auth,method,body);if(r.status!==401||r.body!=='')throw Error('Private Git denial failed');}
 const {s,auth}=await client.authenticate(e=>nostr.finalizeEvent(e,key));s.close();if(auth[2]!==false)throw Error('Nonmember relay admitted');
 result.repositories.push({root:entry.root,memberMainRead:true,anonymousReadDenied:true,nonmemberReadDenied:true,nonmemberPushDenied:true,nonmemberRelayDenied:true});
 writeFileSync(dirname(config)+'/private-verification.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(client.coordinate.identifier+': member read and anonymous/nonmember denials verified');
}
