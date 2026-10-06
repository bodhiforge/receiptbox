import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase,migrate} from '../src/database.mjs';
import {OriginalStore} from '../src/originals.mjs';
import {createReceiptService} from '../src/receipts.mjs';
import {RecognitionQueue,extractedFields} from '../src/recognition.mjs';
import {NotificationDelivery} from '../src/notifications.mjs';
import {TelegramInbox} from '../src/telegram.mjs';

const pdf=Buffer.from('%PDF-1.4\nFictional architecture fixture\n%%EOF\n');
const output=()=>({model:'test',result:{documentKind:'receipt',warnings:[],fields:Object.fromEntries(extractedFields.map(k=>[k,{value:null,confidence:'low',evidence:''}]))}});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t){
  const data=await mkdtemp(join(tmpdir(),'receiptbox-architecture-'));
  const db=openDatabase(join(data,'receipts.sqlite'));
  t.after(async()=>{db.close();await rm(data,{recursive:true,force:true});});
  let service;
  const queue=new RecognitionQueue({db,getReceipt:id=>service.get(id),enabled:true,runModel:async()=>output()});
  service=createReceiptService({db,data,recognition:queue});
  return {db,data,queue,service};
}

test('partial legacy original is quarantined and repaired before acknowledgement',async t=>{
  const {data,service}=await fixture(t);
  const hash=createHash('sha256').update(pdf).digest('hex');
  await mkdir(join(data,'originals'));
  await writeFile(join(data,'originals',hash),pdf.subarray(0,8));
  const saved=await service.ingest({bytes:pdf,name:'original.pdf'});
  assert.deepEqual(await readFile(join(data,'originals',hash)),pdf);
  assert.equal(saved.receipt.files[0].size,pdf.length);
  assert.equal((await readdir(join(data,'quarantine'))).length,1);
  await writeFile(join(data,'originals',hash),'damaged');
  const duplicate=await service.ingest({bytes:pdf,name:'retry.pdf'});
  assert.equal(duplicate.duplicate,true);
  assert.deepEqual(await readFile(join(data,'originals',hash)),pdf);
});

test('interrupted temporary write never publishes a partial original or receipt',async t=>{
  const {data,db,queue}=await fixture(t);
  const store=new OriginalStore(data,{checkpoint:async phase=>{if(phase==='written')throw Error('simulated interruption');}});
  const service=createReceiptService({db,data,recognition:queue,store});
  await assert.rejects(()=>service.ingest({bytes:pdf}),/interruption/);
  assert.equal(db.prepare('SELECT count(*) n FROM receipts').get().n,0);
  assert.ok((await readdir(join(data,'originals'))).every(n=>n.startsWith('.pending-')));
  const healthy=createReceiptService({db,data,recognition:queue});
  await healthy.ingest({bytes:pdf});
  assert.equal(db.prepare('SELECT count(*) n FROM receipt_ai').get().n,1);
});

test('receipt, event, source mapping and job are one atomic commit',async t=>{
  const {data,db,queue}=await fixture(t);
  const failing=createReceiptService({db,data,recognition:{latest:()=>null,enqueue:()=>{throw Error('queue failure');}}});
  const source={bot:'1',chat:'2',message:3,transport:'document'};
  await assert.rejects(()=>failing.ingest({bytes:pdf,source,purpose:'Project meeting'}),/queue failure/);
  for(const table of ['receipts','files','events','receipt_ai','telegram_receipts'])assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  const healthy=createReceiptService({db,data,recognition:queue});
  const result=await healthy.ingest({bytes:pdf,source,purpose:'Project meeting'});
  assert.equal(result.receipt.purpose,'Project meeting');
  for(const table of ['receipts','files','events','receipt_ai','telegram_receipts'])assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n,1);
});

test('concurrent uploads of identical bytes produce one verified original and expense',async t=>{
  const {data,db,service}=await fixture(t);
  const results=await Promise.all(Array.from({length:12},()=>service.ingest({bytes:pdf,name:'duplicate.pdf'})));
  assert.equal(results.filter(r=>!r.duplicate).length,1);
  assert.equal(new Set(results.map(r=>r.receipt.id)).size,1);
  const original=results[0].receipt.files[0];
  assert.deepEqual(await readFile(join(data,'originals',original.hash)),pdf);
  for(const table of ['receipts','documents','expense_documents','events','receipt_ai'])assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n,1);
});

test('live leases survive another worker startup; expired workers cannot publish',async t=>{
  const {db,service}=await fixture(t);const receipt=(await service.ingest({bytes:pdf})).receipt;
  let now=1000;const slow=deferred(),started=deferred();
  const first=new RecognitionQueue({db,getReceipt:service.get,enabled:true,clock:()=>now,leaseMs:100000,runModel:async()=>{started.resolve();await slow.promise;return {...output(),model:'stale'};}});
  const work=first.tick();await started.promise;
  const second=new RecognitionQueue({db,getReceipt:service.get,enabled:true,clock:()=>now,leaseMs:100000,runModel:async()=>({...output(),model:'new-owner'})});
  assert.equal(second.claim(),null);
  now+=100001;await second.tick();slow.resolve();await work;
  assert.equal(second.latest(receipt.id).model,'new-owner');
  assert.equal(db.prepare('SELECT count(*) n FROM notification_outbox').get().n,1);
});

test('a blocked notification never holds up the next recognition job',async t=>{
  const {db,queue,service}=await fixture(t);
  await service.ingest({bytes:pdf});await queue.tick();
  await service.ingest({bytes:Buffer.concat([pdf,Buffer.from('second')])});
  const gate=deferred(),started=deferred();
  const delivery=new NotificationDelivery({db,getReceipt:service.get,recognition:queue,send:async()=>{started.resolve();await gate.promise;return false;}});
  const pending=delivery.tick();await started.promise;
  await queue.tick();assert.equal(db.prepare("SELECT count(*) n FROM receipt_ai WHERE status='ready'").get().n,2);
  gate.resolve();await pending;
  assert.equal(db.prepare("SELECT count(*) n FROM notification_outbox WHERE status='pending'").get().n,2);
});

test('durable incoming Telegram updates advance offset safely and isolate retries',async t=>{
  const {db,data}=await fixture(t);
  const inbox=new TelegramInbox({db,data});inbox.config={bot:'test',owner:'2'};
  const updates=[{update_id:10,message:{text:'fails'}},{update_id:11,message:{text:'succeeds'}}];
  inbox.persistUpdates(updates);inbox.persistUpdates(updates);
  assert.equal(db.prepare('SELECT next_offset FROM telegram_offsets').get().next_offset,12);
  assert.equal(db.prepare('SELECT count(*) n FROM telegram_updates').get().n,2);
  inbox.handle=async u=>{if(u.update_id===10)throw Error('transport failure');};
  await inbox.processOne();await inbox.processOne();
  assert.equal(db.prepare('SELECT status FROM telegram_updates WHERE id=10').get().status,'pending');
  assert.equal(db.prepare('SELECT status FROM telegram_updates WHERE id=11').get().status,'done');
});

test('migrations preserve legacy IDs and refuse newer schemas',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec("CREATE TABLE receipts(id TEXT PRIMARY KEY,number INTEGER UNIQUE NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,details TEXT NOT NULL);INSERT INTO receipts VALUES('old',1,'date','date',7,'{}')");
  migrate(db);migrate(db);
  assert.equal(db.prepare('SELECT version FROM receipts WHERE id=?').get('old').version,7);
  db.prepare('INSERT INTO schema_migrations VALUES(999,?,?)').run('future','today');
  assert.throws(()=>migrate(db),/newer/);db.close();
});
