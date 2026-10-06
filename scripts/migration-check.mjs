// Read the live store through SQLite's backup API. All migration/restore work
// happens in a fresh same-host directory; never alter the source database.
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdir,copyFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {migrate} from '../src/database.mjs';
import {verifySnapshot} from '../src/backup.mjs';
import {isEntryPoint} from '../src/cli.mjs';

export async function checkMigration(source,target) {
  await mkdir(target,{mode:0o700});
  const original=new DatabaseSync(join(source,'receipts.sqlite'),{readOnly:true});
  try{await backup(original,join(target,'receipts.sqlite'));}finally{original.close();}
  const copy=new DatabaseSync(join(target,'receipts.sqlite'));
  const queries={receipts:'SELECT * FROM receipts ORDER BY id',files:'SELECT * FROM files ORDER BY id,receipt_id',events:'SELECT * FROM events ORDER BY id',company:'SELECT * FROM company_profile ORDER BY id',ai:'SELECT id,receipt,fingerprint,status,attempts,created,updated,result,error,model,notified FROM receipt_ai ORDER BY id',sources:'SELECT * FROM telegram_receipts ORDER BY bot,chat,message',offsets:'SELECT * FROM telegram_offsets ORDER BY bot'};
  try{
    const before=Object.fromEntries(Object.entries(queries).map(([key,sql])=>[key,copy.prepare(sql).all()]));
    await mkdir(join(target,'originals'));
    for(const row of before.files)await copyFile(join(source,'originals',row.hash),join(target,'originals',row.hash),constants.COPYFILE_FICLONE);
    migrate(copy);
    for(const [key,sql] of Object.entries(queries))assert.deepEqual(copy.prepare(sql).all(),before[key],`Migration changed ${key}`);
    return {schemaVersion:copy.prepare('PRAGMA user_version').get().user_version,preserved:true,...await verifySnapshot(target)};
  }finally{copy.close();}
}
if(isEntryPoint(import.meta.url)){
  try{console.log(JSON.stringify(await checkMigration(...process.argv.slice(2))));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
