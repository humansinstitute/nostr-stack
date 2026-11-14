/** Read-only Forgejo export. Native OAuth stays in this process; output must be ignored. */
import {mkdirSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
const [originArg,directoryArg]=process.argv.slice(2);
const origin=new URL(originArg);
if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('An HTTPS origin is required');
const directory=resolve(directoryArg);
async function command(args:string[],env:NodeJS.ProcessEnv=process.env){const p=Bun.spawn(args,{env,stdout:'pipe',stderr:'pipe'});const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);if(code)throw Error(`${args[0]} ${args[1]} failed (${code}); output withheld`);return out.trim();}
await command(['git','check-ignore',directory]);
if(await command(['git','ls-files','--',directory]))throw Error('Export must be untracked');
if(existsSync(directory))throw Error('Use a new export directory; prior evidence is immutable');
mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
const autopilot=process.env.AUTOPILOT_REPO??`${process.env.HOME}/code/wm/autopilot`;
const {callCapabilityBroker}=await import(`${autopilot}/src/mcp/capability-client.ts`);
const credential:any=await callCapabilityBroker('/api/mcp/capabilities/git-credential',{protocol:'https',host:origin.host,path:process.argv[4]??'rick/2clip.git'});
const headers={authorization:`Bearer ${credential.password}`};
function save(path:string,data:unknown){writeFileSync(join(directory,path),JSON.stringify(data,null,2)+'\n',{mode:0o600});}
async function get(path:string,optional=false):Promise<any>{const r=await fetch(origin.origin+'/api/v1'+path,{headers,redirect:'error',signal:AbortSignal.timeout(30000)});if(optional&&[403,404,405].includes(r.status))return {unavailable:r.status};if(!r.ok)throw Error(`API ${path.split('?')[0]} failed (${r.status})`);return r.json();}
async function pages(path:string,optional=false){const result:any[]=[];for(let page=1;page<=10000;page++){const data=await get(path+(path.includes('?')?'&':'?')+`limit=50&page=${page}`,optional);if(!Array.isArray(data))return data;result.push(...data);if(data.length<50)return result;}throw Error('Pagination incomplete');}
const user=await get('/user');save('actor.json',{id:user.id,login:user.login});
const repos=await pages('/user/repos');save('repositories.json',repos);
const result:any={origin:origin.origin,started_at:new Date().toISOString(),repositories:[],complete:false};save('inventory.json',result);
const env={...process.env};for(const k of Object.keys(env))if(/^(GIT_|WINGMAN_|AUTOPILOT_|SESSION_ID$)|proxy/i.test(k))delete env[k];
Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_COUNT:'4',GIT_CONFIG_KEY_0:'http.followRedirects',GIT_CONFIG_VALUE_0:'false',GIT_CONFIG_KEY_1:'credential.helper',GIT_CONFIG_VALUE_1:'',GIT_CONFIG_KEY_2:'core.hooksPath',GIT_CONFIG_VALUE_2:'/dev/null',GIT_CONFIG_KEY_3:`http.${origin.origin}/.extraHeader`,GIT_CONFIG_VALUE_3:`Authorization: Basic ${Buffer.from(credential.username+':'+credential.password).toString('base64')}`});
for(const repo of repos){
 const name=repo.full_name;if(!/^[\w.-]+\/[\w.-]+$/.test(name))throw Error('Unsafe repository path');
 const prefix=name.replace('/','--');mkdirSync(join(directory,prefix),{mode:0o700});
 const record:any={name,private:repo.private,default_branch:repo.default_branch,status:'exporting'};result.repositories.push(record);save('inventory.json',result);
 const base=`/repos/${name}`;
 for(const [file,path] of Object.entries({issues:'/issues?state=all&type=issues',pulls:'/pulls?state=all',releases:'/releases',milestones:'/milestones?state=all',labels:'/labels',collaborators:'/collaborators',teams:'/teams',branches:'/branches',tags:'/tags',wiki:'/wiki/pages',hooks:'/hooks',branch_protections:'/branch_protections',actions:'/actions/runs'})){
  let data=await pages(base+path,true);
  // Provider webhook configuration may contain credentials: retain topology, never secrets.
  if(file==='hooks'&&Array.isArray(data))data=data.map(({id,type,active,events,config}:any)=>({id,type,active,events,config:config?{url:config.url?new URL(config.url).origin:undefined,content_type:config.content_type}:undefined,credentials_omitted:true}));
  save(`${prefix}/${file}.json`,data);record[file]=Array.isArray(data)?data.length:data;
  if(file==='issues'||file==='pulls')for(const item of Array.isArray(data)?data:[]){save(`${prefix}/${file}-${item.number}-comments.json`,await pages(base+`/issues/${item.number}/comments`));if(file==='pulls'){save(`${prefix}/pull-${item.number}.json`,await get(base+`/pulls/${item.number}`));save(`${prefix}/pull-${item.number}-reviews.json`,await pages(base+`/pulls/${item.number}/reviews`,true));}}
  if(file==='releases')for(const release of Array.isArray(data)?data:[])for(const asset of release.assets??[]){const u=new URL(asset.browser_download_url);if(u.origin!==origin.origin)throw Error('Release asset origin mismatch');const r=await fetch(u,{headers,redirect:'error'});if(!r.ok)throw Error('Release asset export failed');writeFileSync(join(directory,prefix,`asset-${asset.id}`),Buffer.from(await r.arrayBuffer()),{mode:0o600});}
 }
 const bare=join(directory,prefix,'repository.git');await command(['git','clone','--mirror',`${origin.origin}/${name}.git`,bare],env);await command(['git','--git-dir='+bare,'fsck','--full'],env);
 record.refs=await command(['git','--git-dir='+bare,'for-each-ref','--format=%(objectname) %(refname)'],env);
 record.objects=await command(['git','--git-dir='+bare,'rev-list','--objects','--all'],env);save(`${prefix}/git.json`,{refs:record.refs,objects:record.objects});delete record.objects;
 // All LFS and submodule pointers are retained in Git; transfer LFS before any cutover.
 const trees=await command(['git','--git-dir='+bare,'rev-list','--all'],env);const pointers=new Set<string>();const submodules=new Set<string>();
 for(const commit of trees.split('\n').filter(Boolean)){const tree=await command(['git','--git-dir='+bare,'ls-tree','-r',commit],env);for(const line of tree.split('\n'))if(line.startsWith('160000 '))submodules.add(line);const files=tree.split('\n').filter(l=>l.split('\t')[1]?.split('/').at(-1)==='.gitattributes'||l.endsWith('\t.gitmodules'));for(const f of files){const oid=f.split(' ')[2]?.split('\t')[0];if(oid)pointers.add(await command(['git','--git-dir='+bare,'cat-file','-p',oid],env));}}
 record.submodules=[...submodules];record.attributesAndModules=[...pointers];
 if([...pointers].some(x=>x.includes('filter=lfs'))){await command(['git','--git-dir='+bare,'lfs','fetch','--all','origin'],env);record.lfs='all fetched';}else record.lfs='no LFS attributes in reachable history';
 const wiki=await get(base+'/wiki/pages?limit=1',true);if(Array.isArray(wiki)&&wiki.length){await command(['git','clone','--mirror',`${origin.origin}/${name}.wiki.git`,join(directory,prefix,'wiki.git')],env);record.wiki_git='exported';}
 record.status='exported';save('inventory.json',result);console.log(`${name}: refs and metadata exported`);
}
result.complete=true;result.finished_at=new Date().toISOString();save('inventory.json',result);console.log('Export complete; source unchanged');
