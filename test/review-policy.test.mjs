import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assessRecognition} from '../src/review-policy.mjs';
import {blankDetails} from '../src/business.mjs';
import {openDatabase} from '../src/database.mjs';
import {RecognitionQueue,extractedFields,sanitiseResult} from '../src/recognition.mjs';
import {createReceiptService} from '../src/receipts.mjs';
const empty=()=>({...blankDetails,events:[]});
function result(){const fields=Object.fromEntries(extractedFields.map(k=>[k,{value:'',confidence:'low',evidence:''}]));for(const [k,v] of Object.entries({merchant:'Sample Bakery',date:'2026-10-03',subtotal:'47.90',total:'48.40',tax:'0.50',currency:'CAD',category:'meals'}))fields[k]={value:v,confidence:k==='category'?'high':'low',evidence:`Printed ${v}`};fields.subtotal.evidence='Subtotal: 47.90';fields.currency.evidence='Burnaby, BC V5C 0K3';return {documentKind:'receipt',fields,warnings:['No business purpose or GST registration evidence. Date format is ambiguous (2026-10-03).']};}
const at={now:new Date('2026-10-04T20:00:00Z')};
test('supported low-confidence bakery receipt files without business context or named taxes',()=>{
 const a=assessRecognition(empty(),result(),at);assert.equal(a.decision,'file');assert.equal(a.values.tax,'0.50');assert.equal(a.values.currency,'CAD');assert.ok(!('gst' in a.values));
 const r=result();r.fields.tax.value='';assert.equal(assessRecognition(empty(),r,at).decision,'file');assert.ok(!('tax' in assessRecognition(empty(),r,at).values));
});
test('only concrete date, amount and document exceptions stop automatic filing',()=>{
 let r=result();r.fields.date.evidence='03/10/2026';assert.ok(assessRecognition(empty(),r,at).issues.some(i=>i.field==='date'));
 r=result();r.fields.total={value:'40.00',evidence:'Total 40.00',confidence:'high'};assert.ok(assessRecognition(empty(),r,at).issues.some(i=>i.code==='arithmetic'));
 r=result();r.fields.tax={value:'100.00',evidence:'Tax 100.00',confidence:'high'};assert.ok(assessRecognition(empty(),r,at).issues.some(i=>i.code==='tax_exceeds_total'));
 r=result();r.fields.date={value:'2027-10-03',evidence:'2027-10-03',confidence:'high'};assert.ok(assessRecognition(empty(),r,at).issues.some(i=>i.code==='future_date'));
 r=result();r.documentKind='card_slip';assert.equal(assessRecognition(empty(),r,at).decision,'attention');
 r=result();r.fields.total.value='';assert.equal(assessRecognition(empty(),r,at).decision,'attention');
 r=result();r.fields.tip={value:'2.00',evidence:'Tip 2.00',confidence:'high'};assert.ok(assessRecognition(empty(),r,at).issues.some(i=>i.code==='arithmetic'));
});
test('worker files atomically before notification, protects human edits and does not repeat policy events',async()=>{
 const data=await mkdtemp(join(tmpdir(),'receiptbox-policy-')),db=openDatabase(join(data,'receipts.sqlite'));let service;
 const q=new RecognitionQueue({db,getReceipt:id=>service.get(id),enabled:true,runModel:async()=>({result:result(),model:'local/fixture'})});service=createReceiptService({db,data,recognition:q});
 try{
  let {receipt}=await service.ingest({bytes:Buffer.from('%PDF-fictional-policy-test')});
  receipt=service.update(receipt.id,{...receipt,merchant:'Human title',tax:'0.50'});
  await q.tick();receipt=service.get(receipt.id);
  assert.equal(receipt.status,'complete');assert.equal(receipt.merchant,'Human title');assert.equal(receipt.total,'48.40');assert.equal(receipt.gst,'');assert.equal(receipt.events[0].type,'recognition_applied');assert.equal(receipt.ai.result.assessment.decision,'file');assert.equal(db.prepare('SELECT count(*) n FROM notification_outbox').get().n,1);
  const version=receipt.version;service.reconcileJobs();assert.equal(service.get(receipt.id).version,version);
  const next=await service.ingest({bytes:Buffer.from('%PDF-fictional-policy-test-2')});
  let second=service.update(next.receipt.id,{...next.receipt,total:'12.34'});
  second=service.update(second.id,{...second,total:''});await q.tick();second=service.get(second.id);
  assert.equal(second.total,'');assert.equal(second.status,'review');assert.equal(second.ai.result.assessment.issues[0].field,'total');
 }finally{db.close();await rm(data,{recursive:true,force:true});}
});

test('processing is separate from attention and a corrected exception files with one save',async()=>{
 const {createQueries}=await import('../src/queries.mjs');const data=await mkdtemp(join(tmpdir(),'receiptbox-save-')),db=openDatabase(join(data,'receipts.sqlite'));let service;
 const raw=result();raw.fields.date={value:'',evidence:'',confidence:'low'};
 const q=new RecognitionQueue({db,getReceipt:id=>service.get(id),enabled:true,runModel:async()=>({result:raw,model:'fixture'})});service=createReceiptService({db,data,recognition:q});const queries=createQueries(db);
 try{
  const {receipt}=await service.ingest({bytes:Buffer.from('%PDF-save-policy-fixture')});
  assert.equal(queries.facets().processing,1);assert.equal(queries.facets().pending,0);assert.equal(queries.list({status:'pending'}).total,0);assert.equal(queries.list({status:'processing'}).items[0].processing,1);
  await q.tick();assert.equal(queries.facets().processing,0);assert.equal(queries.facets().pending,1);
  let current=service.get(receipt.id);current=service.update(current.id,{...current,date:'2026-10-03',autoStatus:true});assert.equal(current.status,'complete');assert.equal(current.ai.result.assessment.issues.length,0);assert.equal(queries.facets().pending,0);
  current=service.update(current.id,{...current,purpose:'Optional note',autoStatus:true});assert.equal(current.status,'complete');
  current=service.update(current.id,{...current,date:'',autoStatus:true});assert.equal(current.status,'review');assert.equal(queries.facets().pending,1);
 }finally{db.close();await rm(data,{recursive:true,force:true});}
});

test('fuel total evidence is not a subtotal and registration IDs are not tax amounts',async()=>{
 const {createQueries}=await import('../src/queries.mjs');const data=await mkdtemp(join(tmpdir(),'receiptbox-fuel-')),db=openDatabase(join(data,'receipts.sqlite'));let service;
 const raw=result();Object.assign(raw.fields,{subtotal:{value:'70.00',confidence:'high',evidence:'TCTAL CAD $ 70.00'},total:{value:'70.00',confidence:'high',evidence:'TCTAL CAD $ 70.00'},tax:{value:'3.33',confidence:'high',evidence:'GHT INCLUDED IN FUEL $ 3.33'},gst:{value:'859036659',confidence:'high',evidence:'GST 859036659'}});
 const q=new RecognitionQueue({db,getReceipt:id=>service.get(id),enabled:true,runModel:async()=>({result:raw,model:'fixture'})});service=createReceiptService({db,data,recognition:q});
 try{
  const {receipt}=await service.ingest({bytes:Buffer.from('%PDF-fuel-regression')});await q.tick();let r=service.get(receipt.id);
  assert.equal(r.status,'complete');assert.equal(r.total,'70.00');assert.equal(r.tax,'3.33');assert.equal(r.subtotal,'');assert.equal(r.gst,'');
  // Reproduce an old auto-filled record followed by a user's total correction.
  const row=db.prepare('SELECT details FROM receipts WHERE id=?').get(r.id);const details={...JSON.parse(row.details),subtotal:'70.00',gst:'859036659',status:'review'};db.prepare('UPDATE receipts SET details=? WHERE id=?').run(JSON.stringify(details),r.id);
  r=service.get(r.id);r=service.update(r.id,{...r,total:'70',autoStatus:true});assert.equal(r.status,'complete');assert.equal(r.subtotal,'');assert.equal(r.gst,'');assert.equal(r.ai.result.assessment.issues.length,0);
  // A genuinely printed subtotal must still trigger arithmetic checks.
  const conflict=result();conflict.fields.subtotal={value:'70.00',confidence:'high',evidence:'SUBTOTAL 70.00'};assert.ok(assessRecognition(empty(),conflict,at).issues.some(i=>i.code==='arithmetic'));
  const queries=createQueries(db),original=r.files[0].hash;
  assert.equal(queries.report({year:'2026',currency:'CAD'}).totals.count,1);
  r=service.setDeleted(r.id,r.version,true);assert.ok(r.deleted_at);assert.equal(queries.list().total,0);assert.equal(queries.list({status:'trash'}).total,1);assert.equal(queries.facets().total,0);assert.equal(queries.report({year:'2026',currency:'CAD'}).totals.count,0);
  assert.throws(()=>service.update(r.id,{...r,autoStatus:true}),/Restore/);assert.throws(()=>service.setDeleted(r.id,r.version-1,false),/changed/);
  await assert.rejects(service.ingest({bytes:Buffer.from('%PDF-fuel-regression')}),/Trash/);
  r=service.setDeleted(r.id,r.version,false);assert.equal(r.deleted_at,null);assert.equal(r.files[0].hash,original);assert.equal(queries.list().total,1);assert.equal(queries.report({year:'2026',currency:'CAD'}).totals.count,1);assert.ok(r.events.some(e=>e.type==='restored'));
 }finally{db.close();await rm(data,{recursive:true,force:true});}
});

test('uncertain category stays unclassified without blocking filing; utilities is accepted',()=>{
 const raw=result();raw.fields.category={value:null,confidence:'low',evidence:''};
 const assessment=assessRecognition(empty(),sanitiseResult(raw),at);
 assert.equal(assessment.decision,'file');assert.equal(assessment.values.category,undefined);
 raw.fields.category={value:'utilities',confidence:'high',evidence:'Electricity charges'};
 assert.equal(assessRecognition(empty(),sanitiseResult(raw),at).values.category,'utilities');
 const edited={...empty(),category:'office',events:[{type:'edited',details:{category:{from:'',to:'office'}}}]};
 assert.equal(assessRecognition(edited,sanitiseResult(raw),at).values.category,undefined);
});

test('missing currency defaults to CAD while printed currencies and user choices win',()=>{
 const raw=result();raw.fields.currency={value:'',confidence:'low',evidence:''};
 let a=assessRecognition(empty(),raw,at);assert.equal(a.values.currency,'CAD');assert.equal(a.currencySource,'company_default');assert.equal(a.decision,'file');
 raw.fields.total.evidence='Total US$ 48.40';a=assessRecognition(empty(),raw,at);assert.equal(a.values.currency,'USD');assert.equal(a.currencySource,'receipt');
 raw.fields.currency={value:'USD',confidence:'low',evidence:'USD'};a=assessRecognition({...empty(),currency:'EUR'},raw,at);assert.equal(a.values.currency,undefined);
 raw.fields.total.evidence='Total 48.40';raw.fields.currency={value:'CAD',confidence:'low',evidence:'CAD 48.40 or USD 35.00'};assert.ok(assessRecognition(empty(),raw,at).issues.some(i=>i.field==='currency'));
 raw.fields.currency={value:'',confidence:'low',evidence:'AUD 48.40'};assert.ok(assessRecognition(empty(),raw,at).issues.some(i=>i.field==='currency'));
 raw.fields.currency={value:'',confidence:'low',evidence:''};a=assessRecognition({...empty(),merchant:'Saved',date:'2026-10-03',total:'48.40'},raw,{...at,fillMissing:false});assert.equal(a.values.currency,'CAD');
});

test('tax-inclusive fuel sales cannot trap a saved receipt in arithmetic review',async()=>{
 const data=await mkdtemp(join(tmpdir(),'receiptbox-included-tax-')),db=openDatabase(join(data,'receipts.sqlite'));let service;
 const raw=result();Object.assign(raw.fields,{subtotal:{value:'30.00',confidence:'high',evidence:'Fuel sales $ 30.00'},total:{value:'30.00',confidence:'low',evidence:'TOTAL $30.00'},tax:{value:'1.43',confidence:'high',evidence:'GST INCLUDED $1.43'}});
 const q=new RecognitionQueue({db,getReceipt:id=>service.get(id),enabled:true,runModel:async()=>({result:raw,model:'fixture'})});service=createReceiptService({db,data,recognition:q});
 try{
  const {receipt}=await service.ingest({bytes:Buffer.from('%PDF-included-sales')});await q.tick();let r=service.get(receipt.id);
  assert.equal(r.status,'complete');assert.equal(r.subtotal,'');assert.equal(r.total,'30.00');assert.equal(r.tax,'1.43');
  // Historic model subtotal plus a manually corrected total, then Save with no changes.
  db.prepare('UPDATE receipts SET details=? WHERE id=?').run(JSON.stringify({...r,subtotal:'30.00',total:'30',status:'review',files:undefined,events:undefined,ai:undefined}),r.id);
  db.prepare("INSERT INTO events(receipt_id,created,type,details) VALUES(?,'now','edited',?)").run(r.id,JSON.stringify({total:{from:'',to:'30'}}));
  r=service.get(r.id);r=service.update(r.id,{...r,autoStatus:true});
  assert.equal(r.status,'complete');assert.equal(r.subtotal,'');assert.equal(r.total,'30');assert.equal(r.tax,'1.43');assert.equal(r.ai.result.assessment.issues.length,0);
  const edited={...empty(),subtotal:'30.00',total:'30',tax:'1.43',events:[{type:'edited',details:{subtotal:{from:'',to:'30.00'}}}]};
  assert.ok(assessRecognition(edited,raw,at).issues.some(i=>i.code==='arithmetic'));
  const net=structuredClone(raw);net.fields.subtotal.evidence='Subtotal before tax $30.00';assert.ok(assessRecognition(empty(),net,at).issues.some(i=>i.code==='arithmetic'));
  const noIncluded=structuredClone(raw);noIncluded.fields.tax.evidence='GST $1.43';assert.equal(assessRecognition(empty(),noIncluded,at).values.subtotal,undefined);assert.equal(assessRecognition(empty(),noIncluded,at).decision,'file');
 }finally{db.close();await rm(data,{recursive:true,force:true});}
});

test('currency commentary is not mistaken for printed foreign currency',()=>{
 const raw=result();raw.fields.currency={value:'CAD',confidence:'high',evidence:'Amount and Tip in USD-like format, but no currency symbol; company default CAD applied'};
 let a=assessRecognition(empty(),raw,at);assert.equal(a.values.currency,'CAD');assert.equal(a.currencySource,'company_default');assert.equal(a.decision,'file');
 raw.fields.currency={value:'USD',confidence:'low',evidence:'USD assumed from the dollar format'};a=assessRecognition(empty(),raw,at);assert.equal(a.values.currency,'CAD');assert.equal(a.decision,'file');
 raw.localCurrencyEvidence=['TOTAL USD 48.40'];a=assessRecognition(empty(),raw,at);assert.equal(a.values.currency,'USD');assert.equal(a.currencySource,'receipt');
 raw.localCurrencyEvidence=['TOTAL USD 48.40','CAD 66.00'];assert.ok(assessRecognition(empty(),raw,at).issues.some(i=>i.field==='currency'));
 raw.localCurrencyEvidence=[];raw.fields.currency={value:'USD',confidence:'high',evidence:'USD 48.40'};assert.equal(assessRecognition(empty(),raw,at).values.currency,'USD');
});

test('optional merchant files through recognition and manual save while financial exceptions remain',async()=>{
 const raw=result();raw.fields.merchant={value:'',confidence:'low',evidence:''};
 assert.equal(assessRecognition(empty(),raw,at).decision,'file');
 const {missingFields}=await import('../src/business.mjs');const {receiptLabel}=await import('../public/receipts.mjs');
 assert.deepEqual(missingFields({date:'2026-10-03',total:'48.40',currency:'CAD'}),[]);
 assert.equal(receiptLabel({merchant:'',category:'utilities',date:'2026-10-03'}),'Utilities · 2026-10-03');
 const data=await mkdtemp(join(tmpdir(),'receiptbox-optional-merchant-')),db=openDatabase(join(data,'receipts.sqlite'));let service;
 const q=new RecognitionQueue({db,getReceipt:id=>service.get(id),enabled:true,runModel:async()=>({result:raw,model:'fixture'})});service=createReceiptService({db,data,recognition:q});
 try{
  const {receipt}=await service.ingest({bytes:Buffer.from('%PDF-optional-merchant')});await q.tick();let r=service.get(receipt.id);
  assert.equal(r.status,'complete');assert.equal(r.merchant,'');
  r=service.update(r.id,{...r,status:'complete',purpose:'Manual save'});assert.equal(r.status,'complete');
  r=service.update(r.id,{...r,total:'',autoStatus:true});assert.equal(r.status,'review');assert.ok(r.ai.result.assessment.issues.some(i=>i.field==='total'));
  // Reassess a historical merchant-only exception using the shared policy, once.
  const details={...blankDetails,date:'2026-10-03',total:'48.40',tax:'0.50',currency:'CAD',category:'meals',status:'review'};
  db.prepare('UPDATE receipts SET details=? WHERE id=?').run(JSON.stringify(details),r.id);
  db.prepare("DELETE FROM events WHERE receipt_id=? AND type='recognition_applied'").run(r.id);
  db.prepare("DELETE FROM events WHERE receipt_id=? AND type='edited'").run(r.id);
  service.reconcileJobs();r=service.get(r.id);assert.equal(r.status,'complete');assert.equal(r.merchant,'');
  const version=r.version,notifications=db.prepare('SELECT count(*) n FROM notification_outbox').get().n;
  service.reconcileJobs();assert.equal(service.get(r.id).version,version);assert.equal(db.prepare('SELECT count(*) n FROM notification_outbox').get().n,notifications);
 }finally{db.close();await rm(data,{recursive:true,force:true});}
 const conflict=result();conflict.fields.merchant=raw.fields.merchant;conflict.fields.tax={value:'80.00',confidence:'high',evidence:'Tax 80.00'};
 assert.equal(assessRecognition(empty(),conflict,at).decision,'attention');
});

test('current charges cannot become a subtotal when adding tax to a historical bill',async()=>{
 const raw=result();Object.assign(raw.fields,{subtotal:{value:'71.64',confidence:'high',evidence:'Current Charges as of: $71.64'},total:{value:'71.64',confidence:'high',evidence:'Total Amount Due: $71.64'},tax:{value:'',confidence:'low',evidence:''}});
 const data=await mkdtemp(join(tmpdir(),'receiptbox-bill-subtotal-')),db=openDatabase(join(data,'receipts.sqlite'));let service;
 const q=new RecognitionQueue({db,getReceipt:id=>service.get(id),enabled:true,runModel:async()=>({result:raw,model:'fixture'})});service=createReceiptService({db,data,recognition:q});
 try{
  const {receipt}=await service.ingest({bytes:Buffer.from('%PDF-current-charge-test')});await q.tick();let r=service.get(receipt.id);assert.equal(r.subtotal,'');
  // Historical model value: never explicitly edited by the user.
  db.prepare('UPDATE receipts SET details=? WHERE id=?').run(JSON.stringify({...blankDetails,merchant:'Utility',date:'2026-10-03',total:'71.64',subtotal:'71.64',currency:'CAD',status:'complete'}),r.id);
  r=service.get(r.id);r=service.update(r.id,{...r,tax:'3.41',autoStatus:true});assert.equal(r.status,'complete');assert.equal(r.total,'71.64');assert.equal(r.tax,'3.41');assert.equal(r.subtotal,'');assert.deepEqual(r.ai.result.assessment.issues,[]);
  // A genuine user-entered subtotal remains intact and conflicting totals stay flagged.
  r=service.update(r.id,{...r,subtotal:'71.64',autoStatus:true});assert.equal(r.status,'review');assert.equal(r.subtotal,'71.64');assert.ok(r.ai.result.assessment.issues.some(i=>i.code==='arithmetic'));
 }finally{db.close();await rm(data,{recursive:true,force:true});}
 const real=result();real.fields.subtotal={value:'71.64',confidence:'high',evidence:'Subtotal: 71.64'};
 assert.ok(assessRecognition(empty(),real,at).issues.some(i=>i.code==='arithmetic'));
});
