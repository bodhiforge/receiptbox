import {appendFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {transaction} from './database.mjs';
import {requestError} from './receipts.mjs';

// Permanently removes receipts that are already in Trash. The caller passes the count and newest
// deletion time it showed the user, so anything trashed after the confirmation is never purged.
export function createTrash({db,data}){
 const busy="EXISTS (SELECT 1 FROM receipt_ai a WHERE a.receipt=r.id AND a.status IN ('queued','running'))";
 // The Telegram inbox creates its own tables; a store that never ran the bot may lack some of them.
 const telegramTables=()=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('telegram_cards','telegram_notifications','telegram_followups','telegram_receipts')").all().map(row=>row.name);
 function summary(){
  const row=db.prepare(`SELECT count(*) count,max(deleted_at) latest,coalesce(sum(${busy}),0) busy FROM receipts r WHERE deleted_at IS NOT NULL`).get();
  return {count:row.count,latest:row.latest||null,busy:row.busy};
 }
 async function empty({count,latest,actor}){
  if(!Number.isInteger(count)||count<1||typeof latest!=='string'||!latest)throw requestError(400,'Open Trash again before emptying it.');
  const result=transaction(db,()=>{
   const rows=db.prepare(`SELECT r.*,${busy} busy FROM receipts r WHERE deleted_at IS NOT NULL AND deleted_at<=?`).all(latest);
   if(rows.length!==count)throw requestError(409,'Trash changed. Review it again before emptying.');
   const purge=rows.filter(r=>!r.busy),purgedAt=new Date().toISOString(),log=[],orphanHashes=[];
   for(const r of purge){
    const details=JSON.parse(r.details),files=db.prepare('SELECT document_id id,hash FROM expense_documents e JOIN documents d ON d.id=e.document_id WHERE e.expense_id=?').all(r.id);
    const jobs=db.prepare('SELECT id FROM receipt_ai WHERE receipt=?').all(r.id).map(j=>j.id);
    for(const job of jobs)db.prepare('DELETE FROM notification_outbox WHERE job=?').run(job);
    for(const table of telegramTables())db.prepare(`DELETE FROM ${table} WHERE receipt=?`).run(r.id);
    db.prepare('DELETE FROM receipt_ai WHERE receipt=?').run(r.id);
    db.prepare('DELETE FROM events WHERE receipt_id=?').run(r.id);
    db.prepare('DELETE FROM receipt_search WHERE id=?').run(r.id);
    db.prepare('DELETE FROM expense_documents WHERE expense_id=?').run(r.id);
    // A kept receipt that pointed at this one as its possible duplicate loses the pointer, with an audit event.
    for(const other of db.prepare('SELECT id FROM receipts WHERE duplicate_of=? AND id<>?').all(r.id,r.id)){
     db.prepare('UPDATE receipts SET duplicate_of=NULL,version=version+1,updated=? WHERE id=?').run(purgedAt,other.id);
     db.prepare('INSERT INTO events(receipt_id,created,type,details) VALUES(?,?,?,?)').run(other.id,purgedAt,'duplicate_source_purged',JSON.stringify({reference:`RC-${String(r.number).padStart(5,'0')}`}));
    }
    db.prepare('DELETE FROM receipts WHERE id=?').run(r.id);
    for(const file of files)if(!db.prepare('SELECT 1 FROM expense_documents WHERE document_id=?').get(file.id)){db.prepare('DELETE FROM documents WHERE id=?').run(file.id);orphanHashes.push(file.hash);}
    log.push({purgedAt,actor,reference:`RC-${String(r.number).padStart(5,'0')}`,trashedAt:r.deleted_at,merchant:details.merchant||'',date:details.date||'',total:details.total||'',currency:details.currency||'',files:files.map(f=>f.hash)});
   }
   return {purged:purge.length,skipped:rows.length-purge.length,log,orphanHashes};
  });
  // Files go only after the commit; a failed unlink leaves an unreferenced file, never a dangling record.
  await Promise.all(result.orphanHashes.map(hash=>Promise.all([rm(join(data,'originals',hash),{force:true}),rm(join(data,'previews','v1',hash),{recursive:true,force:true})]).catch(()=>{})));
  if(result.log.length)await appendFile(join(data,'trash-purges.jsonl'),result.log.map(entry=>JSON.stringify(entry)).join('\n')+'\n',{mode:0o600});
  return {purged:result.purged,skipped:result.skipped,...summary()};
 }
 return {summary,empty};
}
