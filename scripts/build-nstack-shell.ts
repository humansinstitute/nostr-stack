import {mkdir,copyFile,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {buildNstackConsoleHtml} from '../src/nstack-console';
const destination=resolve(process.argv[2]||'dist/nstack-shell');
await mkdir(join(destination,'ui/assets'),{recursive:true});
const build=await Bun.build({entrypoints:['src/console/shell.ts'],outdir:join(destination,'ui/assets'),naming:'shell.js',target:'browser',minify:true});
if(!build.success)throw Error(build.logs.join('\n'));
let html=buildNstackConsoleHtml('',{defaultWorkspaceModel:'typed'});
const css=html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
const javascript=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
if(!css||!javascript)throw Error('Known console asset markers missing');
const shellScript='window.__NSTACK_PACKAGED_SHELL__=true;\n'+javascript.replaceAll("'/ui/assets/crypto.js'","'./crypto.js'").replaceAll("'/ui/assets/shell.js'","'./shell.js'");
await writeFile(join(destination,'ui/assets/console.js'),shellScript);
await writeFile(join(destination,'ui/assets/console.css'),css.replaceAll("'/ui/assets/","'./").replaceAll('"/ui/assets/','"./'));
html=html.replace(/<style>[\s\S]*?<\/style>/,'<link rel="stylesheet" href="ui/assets/console.css">').replace(/<script type="module">[\s\S]*?<\/script>/,'<script type="module" src="ui/assets/console.js"></script>').replaceAll('src="/ui/assets/','src="ui/assets/').replaceAll('href="/ui"','href="index.html"');
html=html.replace(/href="(\/(?:ui\/advanced|docs|admin|table-viewer))"/g,(_,path)=>'data-nstack-api-path="'+path+'" href="#"');
await writeFile(join(destination,'index.html'),html);
const types:Record<string,string>={'index.html':'text/html; charset=utf-8','ui/assets/shell.js':'text/javascript; charset=utf-8','ui/assets/console.js':'text/javascript; charset=utf-8','ui/assets/console.css':'text/css; charset=utf-8'};
for(const name of ['nstack-horizontal-white.svg','InterVariable.ttf','Inter-OFL.txt','crypto.js','crypto-LICENSE.txt']){
 await copyFile(join('src/console/assets',name),join(destination,'ui/assets',name));types['ui/assets/'+name]=name.endsWith('.svg')?'image/svg+xml':name.endsWith('.ttf')?'font/ttf':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/plain; charset=utf-8';
}
const git=Bun.spawn(['git','rev-parse','HEAD'],{stdout:'pipe',stderr:'ignore'});const revision=(await new Response(git.stdout).text()).trim();if(await git.exited!==0||!/^[a-f0-9]{40}$/.test(revision))throw Error('Source revision required');
const files:Record<string,{sha256:string;contentType:string}>={};
for(const [name,contentType] of Object.entries(types))files[name]={sha256:createHash('sha256').update(await readFile(join(destination,name))).digest('hex'),contentType};
const manifest=JSON.stringify({schemaVersion:1,id:'nstack',sourceRevision:revision,entrypoint:'index.html',files},null,2)+'\n';await writeFile(join(destination,'manifest.json'),manifest);
console.log(JSON.stringify({directory:destination,manifestSha256:createHash('sha256').update(manifest).digest('hex'),sourceRevision:revision,assets:Object.keys(files).length}));
