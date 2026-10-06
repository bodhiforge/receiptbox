// A conservative hint only: never merge originals or change bookkeeping state.
const merchantKey=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const cents=value=>/^\d{1,9}(\.\d{1,2})?$/.test(String(value??''))?Math.round(Number(value)*100):null;
export function possibleDuplicate(db,receipt){
 const merchant=merchantKey(receipt.merchant),amount=cents(receipt.total);
 if(receipt.deleted_at||merchant.length<3||amount===null||!receipt.currency||!/^\d{4}-\d{2}-\d{2}$/.test(receipt.date||''))return null;
 const rows=db.prepare("SELECT id,number,details FROM receipts WHERE deleted_at IS NULL AND number<? AND json_extract(details,'$.date')=? AND json_extract(details,'$.currency')=? ORDER BY number").all(receipt.number,receipt.date,receipt.currency);
 const match=rows.find(row=>{const d=JSON.parse(row.details);return merchantKey(d.merchant)===merchant&&cents(d.total)===amount;});
 return match?{id:match.id,reference:`RC-${String(match.number).padStart(5,'0')}`}:null;
}

export const duplicateKey=r=>JSON.stringify([merchantKey(r.merchant),r.date,r.currency,cents(r.total)]);
export function syncDuplicates(db){
 for(const row of db.prepare('SELECT * FROM receipts ORDER BY number').all()){
  const r={...row,...JSON.parse(row.details)},key=duplicateKey(r);
  const candidate=row.duplicate_decision==='keep'&&row.duplicate_key===key?null:possibleDuplicate(db,r);
  const target=candidate?.id||null;
  if(target!==row.duplicate_of)db.prepare('UPDATE receipts SET duplicate_of=?,version=version+1 WHERE id=?').run(target,row.id);
 }
}
