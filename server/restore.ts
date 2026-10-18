// Offline restore tool. Stop the hub before running this command.
// npx tsx server/restore.ts --source data/backups/demo-hotel-....sqlite --target data/demo-hotel.sqlite
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const argument=(name:string)=>process.argv[process.argv.indexOf(name)+1];
if(!process.argv.includes('--source')||!process.argv.includes('--target'))throw new Error('Usage: npx tsx server/restore.ts --source BACKUP.sqlite --target data/demo-hotel.sqlite (stop the hub first)');
const source=resolve(argument('--source'));const target=resolve(argument('--target'));
if(source===target)throw new Error('Source and target must be different files.');
if(!existsSync(source))throw new Error('Backup file does not exist.');
const checksumPath=`${source}.sha256`;
if(existsSync(checksumPath)) {const actual=createHash('sha256').update(readFileSync(source)).digest('hex');const expected=readFileSync(checksumPath,'utf8').split(/\s+/)[0];if(actual!==expected)throw new Error('Backup checksum does not match.');}
const check=new DatabaseSync(source,{readOnly:true});
try {if(check.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new Error('Backup integrity check failed.');for(const table of ['records','commands','outbox','credentials','metadata'])if(!check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))throw new Error('Backup is not an Ember database.');}finally{check.close();}
mkdirSync(dirname(target),{recursive:true});
if(existsSync(target)) {
  // EXCLUSIVE catches active writers; operator must stop all hub processes to release readers too.
  const current=new DatabaseSync(target);try{current.exec('PRAGMA busy_timeout=1000; BEGIN EXCLUSIVE; COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');}finally{current.close();}
  copyFileSync(target,`${target}.before-restore-${Date.now()}`);
}
const temporary=`${target}.restore-${Date.now()}`;copyFileSync(source,temporary);
const restored=new DatabaseSync(temporary);try{restored.exec('DELETE FROM sessions;');}finally{restored.close();}
renameSync(temporary,target);
for(const suffix of ['-wal','-shm'])if(existsSync(`${target}${suffix}`))rmSync(`${target}${suffix}`);
console.log(`Restored verified backup to ${target}. Start the hub and sign in again.`);
