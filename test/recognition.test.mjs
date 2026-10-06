import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/database.mjs';
import {RecognitionQueue,sanitiseResult,extractedFields,receiptFingerprint} from '../src/recognition.mjs';
import {NotificationDelivery} from '../src/notifications.mjs';
import {fiscalPeriod,summarise,validateProfile,defaultProfile} from '../src/business.mjs';
function output(){const fields=Object.fromEntries(extractedFields.map(k=>[k,{value:null,confidence:'low',evidence:''}]));for(const [k,v] of Object.entries({merchant:'Sample Cafe',date:'2026-10-02',currency:'CAD',category:'meals',subtotal:'60.00',total:'70.00',tax:'3.00',tip:'7.00'}))fields[k]={value:v,confidence:'high',evidence:`Printed ${v}`};return {documentKind:'receipt',fields,warnings:[]};}
test('unknown values stay unknown and impossible amounts/dates cannot silently become facts',()=>{
  const raw=output();raw.fields.gst.value='-1';raw.fields.date.value='2026-02-30';raw.fields.total.value='99.00';raw.fields.merchant.evidence='';
  const r=sanitiseResult(raw);assert.equal(r.fields.gst.value,'');assert.equal(r.fields.hst.value,'');assert.equal(r.fields.date.value,'');assert.equal(r.fields.merchant.value,'');assert.equal(r.fields.total.confidence,'low');assert.ok(r.warnings.length>=3);
});
test('queue is durable, idempotent, resumes work and preserves receipt fields',async()=>{
  const db=openDatabase(':memory:');db.prepare('INSERT INTO receipts(id,number,created,updated,details) VALUES(?,?,?,?,?)').run('r1',1,'now','now','{}');
  const receipt={id:'r1',merchant:'Human entered',files:[{hash:'a'}]};let calls=0,notifications=0;
  const config={db,getReceipt:()=>receipt,runModel:async()=>{calls++;return {result:output(),model:'local/test'};},notify:async()=>{notifications++;return true;},enabled:true};
  let q=new RecognitionQueue(config);q.enqueue(receipt);q.enqueue(receipt);assert.equal(db.prepare('SELECT count(*) n FROM receipt_ai').get().n,1);
  db.prepare("UPDATE receipt_ai SET status='running'").run();q=new RecognitionQueue(config);await q.tick();assert.equal(calls,1);assert.equal(notifications,0);const delivery=new NotificationDelivery({db,getReceipt:()=>receipt,recognition:q,send:config.notify});await delivery.tick();assert.equal(notifications,1);assert.equal(q.latest('r1').status,'ready');assert.equal(receipt.merchant,'Human entered');
  receipt.files.push({hash:'b'});q.enqueue(receipt);receipt.files.push({hash:'c'});await q.tick();assert.equal(q.latest('r1').status,'superseded');assert.equal(calls,1);
  q.enqueue(receipt);await q.tick();assert.equal(calls,2);assert.equal(q.latest('r1').fingerprint,receiptFingerprint(receipt));db.close();
});
test('fiscal periods and summaries do not mix currencies or hide unknown amounts',()=>{
  assert.deepEqual(fiscalPeriod('06-30',2026),{from:'2025-07-01',to:'2026-06-30'});
  assert.deepEqual(fiscalPeriod('02-29',2025),{from:'2024-03-01',to:'2025-02-28'});
  const g=summarise([{currency:'CAD',category:'fuel',status:'complete',total:'0.10',tax:''},{currency:'CAD',category:'fuel',status:'complete',total:'0.20',tax:'0'},{currency:'USD',category:'fuel',status:'review',total:'8',tax:''}]);
  assert.equal(g.length,2);assert.equal(g[0].total,'0.30');assert.equal(g[0].unknownTax,1);assert.equal(g[1].currency,'USD');
  assert.throws(()=>validateProfile({...defaultProfile,fiscalYearEnd:'02-30'}));
});
