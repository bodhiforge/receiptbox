import {filingFields} from '../public/receipt-policy.mjs';
import {possibleDuplicate,syncDuplicates,duplicateKey} from './duplicates.mjs';
import {randomUUID} from 'node:crypto';
import {blankDetails, categories} from './business.mjs';
import {receiptName,searchText} from '../public/receipts.mjs';
import {receiptFingerprint, extractedFields} from './recognition.mjs';
import {transaction} from './database.mjs';
import {assessRecognition,policyVersion} from './review-policy.mjs';
import {OriginalStore} from './originals.mjs';

export const requestError=(status,message)=>Object.assign(new Error(message),{status});
export function detect(bytes) {
  if(bytes.subarray(0,5).toString()==='%PDF-') return 'application/pdf';
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if(bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return 'image/jpeg';
  if(bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP') return 'image/webp';
  if(bytes.subarray(4,8).toString()==='ftyp' && /heic|heix|mif1|hevc|hevx/.test(bytes.subarray(8,40).toString())) return 'image/heic';
  throw requestError(415,'Choose a JPG, PNG, WebP, HEIC or PDF receipt.');
}

export function createReceiptService({db,data,recognition,store=new OriginalStore(data)}) {
  const blank=blankDetails, fields=Object.keys(blank), statuses=['review','missing','complete'];
  const errors=requestError, utc=()=>new Date().toISOString();
  const event=(id,type,details)=>{db.prepare('INSERT INTO events(receipt_id,created,type,details) VALUES(?,?,?,?)').run(id,utc(),type,JSON.stringify(details));syncDuplicates(db);};
  const index=id=>db.prepare('INSERT INTO receipt_search VALUES(?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text').run(id,searchText(get(id)));
const get = id => {
  const row = db.prepare('SELECT * FROM receipts WHERE id=?').get(id);
  if (!row) throw errors(404, 'Receipt not found.');
  const named={...blank,...JSON.parse(row.details),created:row.created,reference:`RC-${String(row.number).padStart(5,'0')}`};
  return {...row, ...blank, ...JSON.parse(row.details),displayName:receiptName(named), details:undefined, ai:recognition?.latest(id)||null,
    reference:`RC-${String(row.number).padStart(5,'0')}`,
    possibleDuplicate:row.duplicate_of?{id:row.duplicate_of}:null,duplicatePending:Boolean(row.duplicate_of),status:row.duplicate_of?'review':named.status,
    files:db.prepare('SELECT * FROM files WHERE receipt_id=? ORDER BY created,id').all(id),
    events:db.prepare('SELECT * FROM events WHERE receipt_id=? ORDER BY id DESC').all(id).map(e=>({...e, details:JSON.parse(e.details)})),
    telegramSources:db.prepare('SELECT chat,message,transport FROM telegram_receipts WHERE receipt=?').all(id)};
};
function validate(input) {
  input={...blank,...input};
  const out = {};
  for (const key of fields) {
    if (typeof input[key] !== 'string' || input[key].length > (key === 'purpose' ? 2000 : 250)) throw errors(400, `Invalid ${key}.`);
    out[key] = input[key].trim();
  }
  if (!statuses.includes(out.status) || !categories.includes(out.category) || !['','CAD','USD','EUR','GBP','JPY','TWD'].includes(out.currency)) throw errors(400, 'Invalid category, currency or status.');
  if (out.date && (!/^\d{4}-\d{2}-\d{2}$/.test(out.date) || !Number.isFinite(Date.parse(out.date)) || new Date(out.date).toISOString().slice(0,10) !== out.date)) throw errors(400, 'Enter a valid receipt date.');
  for (const key of ['total','tax','subtotal','gst','hst','pst','qst','tip']) if (out[key] && !/^\d{1,9}(\.\d{1,2})?$/.test(out[key])) throw errors(400, `Enter a non-negative ${key} with up to two decimal places.`);
  if (out.total && out.tax && Number(out.tax)>Number(out.total)) throw errors(400, 'Tax cannot exceed the total.');
  if (out.status === 'complete') {
    const required = filingFields;
    if (required.some(k=>!out[k])) throw errors(400, 'Add date, total and currency before filing.');
  }
  return out;
}

  async function ingest({bytes,name='receipt',title='',receiptId=null,source=null,purpose=''}) {
    if(!Buffer.isBuffer(bytes)||bytes.length===0)throw errors(400,'Choose a non-empty receipt file.');
    if(bytes.length>20*1024*1024)throw errors(413,'Each file must be 20 MB or smaller.');
    if(typeof title!=='string'||title.length>250)throw errors(400,'Receipt name must be 250 characters or fewer.');
    if(receiptId&&get(receiptId).deleted_at)throw errors(409,'Restore this receipt before adding files.');
    const mime=detect(bytes),hash=await store.put(bytes);
    return transaction(db,()=>{
      const existing=db.prepare('SELECT receipt_id FROM files WHERE hash=?').get(hash);
      if(existing&&get(existing.receipt_id).deleted_at)throw errors(409,'This original is in Trash. Restore it before uploading again.');
      const id=existing?.receipt_id||receiptId||randomUUID(), now=utc();
      if(!existing){
        if(!receiptId){
          const number=db.prepare('SELECT COALESCE(MAX(number),0)+1 AS n FROM receipts').get().n;
          const details=validate({...blank,title,purpose});
          db.prepare('INSERT INTO receipts(id,number,created,updated,details) VALUES(?,?,?,?,?)').run(id,number,now,now,JSON.stringify(details));
        }else{
          const r=get(id),details=Object.fromEntries(fields.map(k=>[k,r[k]]));
          details.status='review';
          db.prepare('UPDATE receipts SET updated=?,version=version+1,details=? WHERE id=?').run(now,JSON.stringify(details),id);
        }
        const filename=String(name).replace(/[\x00-\x1f\x7f]/g,'').slice(0,200)||'receipt';
        const documentId=randomUUID();
        db.prepare('INSERT INTO documents VALUES(?,?,?,?,?)').run(documentId,hash,mime,bytes.length,now);
        db.prepare('INSERT INTO expense_documents VALUES(?,?,?,?)').run(id,documentId,filename,now);
        event(id,'uploaded',{name:filename,hash,source:source?'telegram':'web',...(source?.sender?{uploadedBy:{id:source.sender,name:source.senderName||'Member'}}:{})});
      }
      if(source){
        db.prepare('INSERT OR IGNORE INTO telegram_receipts(bot,chat,message,receipt,transport) VALUES(?,?,?,?,?)').run(source.bot,source.chat,source.message,id,source.transport);
      }
      recognition.enqueue(get(id));
      index(id);
      return {duplicate:Boolean(existing),receipt:get(id)};
    });
  }
  function update(id,input) {
    return transaction(db,()=>{
      const previous=get(id);
      if(previous.deleted_at)throw errors(409,'Restore this receipt before editing.');
      if(input.version!==previous.version)throw errors(409,'This receipt changed. Reopen it before saving.');
      const details=validate(input.autoStatus?{...input,status:'review'}:input),changes={};
      if(input.autoStatus){
        const job=recognition?.latest(id);
        const result=job?.status==='ready'&&job.fingerprint===receiptFingerprint(previous)?job.result:null;
        const editedFields=fields.filter(key=>details[key]!==previous[key]);
        const checked=assessRecognition({...previous,...details,events:[...previous.events,{type:'edited',details:Object.fromEntries(editedFields.map(key=>[key,true]))}]},{fields:result?.fields||{},documentKind:result?.documentKind||'receipt',warnings:result?.warnings||[]},{fillMissing:false});
        Object.assign(details,checked.values);
        for(const issue of result?.assessment?.issues||[])if(issue.code==='unsupported'&&!details[issue.field]&&details[issue.field]===previous[issue.field]&&!checked.issues.some(i=>i.field===issue.field))checked.issues.push(issue);
        const confirmed=input.confirmDocument===true||result?.assessment?.documentConfirmed===true;
        if(confirmed)checked.issues=checked.issues.filter(i=>i.field!=='document');
        checked.decision=checked.issues.length?'attention':'file';
        details.status=checked.decision==='file'?'complete':'review';
        if(result)db.prepare('UPDATE receipt_ai SET result=? WHERE id=?').run(JSON.stringify({...result,assessment:{...checked,documentConfirmed:confirmed}}),job.id);
        if(input.confirmDocument===true)event(id,'document_confirmed',{});
      }
      for(const key of fields)if(details[key]!==previous[key])changes[key]={from:previous[key],to:details[key]};
      if(Object.keys(changes).length){
        db.prepare('UPDATE receipts SET details=?,updated=?,version=version+1 WHERE id=?').run(JSON.stringify(details),utc(),id);
        event(id,'edited',changes);
        index(id);
      }
      return get(id);
    });
  }
function acceptRecognition(id,jobId,version){
  const previous=get(id),job=recognition.latest(id);
  if(previous.deleted_at)throw errors(409,'Restore this receipt before editing.');
  if(!job||job.id!==jobId||job.status!=='ready'||job.fingerprint!==receiptFingerprint(previous))throw errors(409,'Recognition changed. Reopen the receipt before accepting.');
  if(previous.version!==version)throw errors(409,'Receipt changed. Reopen before accepting.');
  const details=Object.fromEntries(fields.map(k=>[k,previous[k]])),changes={};
  for(const key of extractedFields){const item=job.result.fields[key];if(!details[key]&&item.value&&item.confidence!=='low'){details[key]=item.value;changes[key]={from:previous[key],to:item.value};}}
  // CAD is a pre-existing default; never silently replace a user value.
  if(!Object.keys(changes).length)return previous;
  details.status='review';validate(details);
  db.exec('BEGIN IMMEDIATE');
  try{db.prepare('UPDATE receipts SET details=?,updated=?,version=version+1 WHERE id=?').run(JSON.stringify(details),utc(),id);event(id,'recognition_accepted',{job:job.id,model:job.model,changes});index(id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  return get(id);
}

  // Called inside the queue transaction, before its notification becomes visible.
  function autoApply(id) {
    const previous=get(id),job=recognition.latest(id);
    if(!job||job.status!=='ready'||job.fingerprint!==receiptFingerprint(previous))return previous;
    if(previous.events.some(e=>e.type==='recognition_applied'&&e.details.job===job.id&&e.details.policy===policyVersion))return previous;
    if(previous.status==='complete'||previous.deleted_at)return previous;
    const assessment=assessRecognition(previous,job.result),details=Object.fromEntries(fields.map(k=>[k,previous[k]])),changes={};
    Object.assign(details,assessment.values);
    // Keep contradictory candidates in recognition evidence rather than saved totals.
    for(const issue of assessment.issues)if(issue.field in assessment.values)details[issue.field]=previous[issue.field];
    if(details.tax&&details.total&&Number(details.tax)>Number(details.total)){
      for(const key of ['total','tax'])if(key in assessment.values)details[key]=previous[key];
    }
    details.status=assessment.decision==='file'?'complete':'review';
    validate(details);
    for(const key of fields)if(details[key]!==previous[key])changes[key]={from:previous[key],to:details[key]};
    db.prepare('UPDATE receipt_ai SET result=? WHERE id=?').run(JSON.stringify({...job.result,assessment}),job.id);
    db.prepare('UPDATE receipts SET details=?,updated=?,version=version+1 WHERE id=?').run(JSON.stringify(details),utc(),id);
    event(id,'recognition_applied',{job:job.id,model:job.model,policy:policyVersion,decision:assessment.decision,issues:assessment.issues,...(assessment.currencySource?{currencySource:assessment.currencySource}:{}),changes});index(id);
    return get(id);
  }
  if(recognition)recognition.onReady=autoApply;
  function reconcileJobs() {
    // Repair historic commit/enqueue gaps. Repeated calls never duplicate jobs.
    transaction(db,()=>{for(const row of db.prepare('SELECT id FROM receipts WHERE deleted_at IS NULL').all()){recognition.enqueue(get(row.id));autoApply(row.id);}});
  }
  function setDeleted(id,version,deleted){
    return transaction(db,()=>{
      const previous=get(id);
      if(previous.version!==version)throw errors(409,'This receipt changed. Reopen it before continuing.');
      if(Boolean(previous.deleted_at)===deleted)return previous;
      db.prepare('UPDATE receipts SET deleted_at=?,updated=?,version=version+1 WHERE id=?').run(deleted?utc():null,utc(),id);
      event(id,deleted?'deleted':'restored',{});
      return get(id);
    });
  }
  function resolveDuplicate(id,version,choice){return transaction(db,()=>{
    syncDuplicates(db);const r=get(id);
    if(r.version!==version||!r.duplicatePending||r.deleted_at)throw errors(409,'This receipt changed. Reopen it before confirming.');
    if(!['keep','existing'].includes(choice))throw errors(400,'Choose Use existing or Keep both.');
    const existing=r.possibleDuplicate.id;
    db.prepare('UPDATE receipts SET duplicate_decision=?,duplicate_key=?,deleted_at=?,updated=?,version=version+1 WHERE id=?').run(choice==='keep'?'keep':'existing',duplicateKey(r),choice==='existing'?utc():null,utc(),id);
    event(id,'duplicate_resolved',{choice,existing});return get(id);
  });}
  transaction(db,()=>syncDuplicates(db));
  return {resolveDuplicate,setDeleted,get,ingest,update,acceptRecognition,reconcileJobs,autoApply,store};
}
