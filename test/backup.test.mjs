import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {snapshot,verifySnapshot} from '../src/backup.mjs';
test('snapshot restores WAL database and detects changed originals',async()=>{
 const data=await mkdtemp(join(tmpdir(),'receiptbox-snapshot-test-'));
 try{
  await mkdir(join(data,'originals'));const bytes=Buffer.from('fictional receipt bytes'),hash=createHash('sha256').update(bytes).digest('hex');await writeFile(join(data,'originals',hash),bytes);
  const db=new DatabaseSync(join(data,'receipts.sqlite'));db.exec('PRAGMA journal_mode=WAL; CREATE TABLE receipts(id TEXT PRIMARY KEY); CREATE TABLE files(hash TEXT,size INTEGER); INSERT INTO receipts VALUES(\'1\')');db.prepare('INSERT INTO files VALUES(?,?)').run(hash,bytes.length);
  const result=await snapshot(data);assert.equal(result.receipts,1);assert.equal(result.files,1);
  const status=JSON.parse(await readFile(join(data,'snapshot-status.json'),'utf8'));await writeFile(join(status.folder,'originals',hash),'corrupted');await assert.rejects(()=>verifySnapshot(status.folder),/Original verification failed/);assert.deepEqual(await readFile(join(data,'originals',hash)),bytes);db.close();
 }finally{await rm(data,{recursive:true,force:true});}
});
