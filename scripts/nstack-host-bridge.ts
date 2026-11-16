// Local Docker-host helper bridge. No HTTP API, no key material, fixed files only.
import {hostOperations,writeHostStatus} from '../src/installation/host-state';
import {readInstallationSettings} from '../src/installation/settings';
const directory=process.env.NSTACK_SETTINGS_DIRECTORY;
if(!directory)throw Error('Installation settings directory required');
const store=hostOperations(directory);
try{
 const mode=process.argv[2];
 if(mode==='read')console.log(JSON.stringify({settings:readInstallationSettings(directory),operation:store.next()}));
 else if(mode==='write'){
  const raw=await Bun.stdin.text();if(raw.length>16384)throw Error('Host status too large');const value=JSON.parse(raw);
  writeHostStatus(directory,value.status);if(value.operation)store.save(value.operation);
 }else throw Error('Supported bridge read/write only');
}finally{store.close();}
