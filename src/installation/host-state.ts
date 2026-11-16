import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
export interface HostOperation {id:string;action:'install';state:'pending'|'running'|'awaiting_os_authorization'|'recheck_required'|'failed'|'complete';}
export function hostOperations(directory:string){
 const db=new Database(join(directory,'host-operations.sqlite'),{create:true});db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS host_operations(id TEXT PRIMARY KEY, operation TEXT NOT NULL)');
 return {
  enqueue:db.transaction((id:string)=>{
   const prior=db.query('SELECT operation FROM host_operations WHERE id=?').get(id) as {operation:string}|null;if(prior)return JSON.parse(prior.operation) as HostOperation;
   const active=db.query("SELECT id FROM host_operations WHERE json_extract(operation,'$.state') IN ('pending','running','awaiting_os_authorization') LIMIT 1").get();if(active)throw Error('host_operation_busy');
   const op:HostOperation={id,action:'install',state:'pending'};db.query('INSERT INTO host_operations VALUES(?,?)').run(id,JSON.stringify(op));return op;
  }),
  next:()=>{const row=db.query("SELECT operation FROM host_operations WHERE json_extract(operation,'$.state') IN ('pending','running','awaiting_os_authorization') LIMIT 1").get() as {operation:string}|null;return row?JSON.parse(row.operation) as HostOperation:null;},
  save:(op:HostOperation)=>db.query("UPDATE host_operations SET operation=? WHERE id=? AND json_extract(operation,'$.state') NOT IN ('complete','failed','recheck_required') AND NOT(json_extract(operation,'$.state')='awaiting_os_authorization' AND ?='running')").run(JSON.stringify(op),op.id,op.state),
  close:()=>db.close(),
 };
}
export function readHostStatus(directory:string){
 try{
  const value=JSON.parse(readFileSync(join(directory,'host-status.json'),'utf8'));
  if(!Number.isFinite(value.observed_at)||Date.now()-value.observed_at>15000)return {state:'host_helper_not_running',requirement:'Start the NStack host helper on the Docker host to inspect or install FIPS.'};
  return value;
 }catch{return {state:'host_helper_not_running',requirement:'Start the NStack host helper on the Docker host to inspect or install FIPS.'};}
}
export function writeHostStatus(directory:string,value:unknown){const path=join(directory,'host-status.json');writeFileSync(path+'.tmp',JSON.stringify(value),{mode:0o600});renameSync(path+'.tmp',path);}
