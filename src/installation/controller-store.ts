import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import {chmodSync} from 'node:fs';
import type {ControllerOperation} from './controller';
import type {InstallationSettings} from './settings';

/** SQLite transactions provide crash-safe enqueue and durable signed-event idempotency. */
export function controllerStore(directory:string){
 const path=join(directory,'controller.sqlite');const db=new Database(path,{create:true});chmodSync(path,0o600);
 db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS operations(event_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, operation TEXT NOT NULL)');
 const latest=()=>{const row=db.query('SELECT operation FROM operations ORDER BY sequence DESC LIMIT 1').get() as {operation:string}|null;return row?JSON.parse(row.operation) as ControllerOperation:null;};
 return {
  latest,
  enqueue:db.transaction((eventId:string,desired:InstallationSettings,recover=false)=>{
   const prior=db.query('SELECT operation FROM operations WHERE event_id=?').get(eventId) as {operation:string}|null;
   if(prior)return {operation:JSON.parse(prior.operation) as ControllerOperation,replayed:true};
   const active=latest();
   if(recover){if(!active||active.state!=='recovery_required')throw Error('recovery_not_required');
    const op:ControllerOperation={...active,id:eventId,state:'applying'};
    db.query('INSERT INTO operations VALUES(?,(SELECT COALESCE(MAX(sequence),0)+1 FROM operations),?)').run(eventId,JSON.stringify(op));
    return {operation:op,replayed:false};
   }
   if(active&&['pending','applying','verifying','recovery_required'].includes(active.state))throw Error('operation_busy_or_recovery_required');
   const op:ControllerOperation={id:eventId,state:'pending',desired};
   db.query('INSERT INTO operations VALUES(?,(SELECT COALESCE(MAX(sequence),0)+1 FROM operations),?)').run(eventId,JSON.stringify(op));
   return {operation:op,replayed:false};
  }),
  save:(operation:ControllerOperation)=>{db.query('UPDATE operations SET operation=? WHERE event_id=?').run(JSON.stringify(operation),operation.id);},
  close:()=>db.close(),
 };
}
