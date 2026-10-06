import {categoryNames} from './business.mjs';
const ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/heic':'heic','application/pdf':'pdf'};
const html=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function safeName(value){
 let s=String(value||'').normalize('NFC').toWellFormed().replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g,'-').replace(/\s+/g,' ').replace(/^[. ]+|[. ]+$/g,'');
 // Bound by bytes for filesystems, without cutting a Unicode code point.
 let out='';for(const c of s){if(Buffer.byteLength(out+c)>150)break;out+=c;}
 out=out.replace(/[. ]+$/g,'');return !out?'Receipt':/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(out)?'Receipt '+out:out;
}
export function downloadName(r,file){
 const date=r.date||'Undated';
 const amount=r.total!==''&&r.total!=null?`${r.currency||''} ${Number(r.total).toFixed(2)}`.trim():'Amount unknown';
 const stem=safeName([date,r.title||r.merchant||'Receipt',amount].join(' - '));
 const index=(r.files||[]).findIndex(f=>f.id===file.id);
 return `${stem}${r.files?.length>1?' - page '+(index+1):''}.${ext[file.mime]||'bin'}`;
}
export function exportFiles(records){
 const used=new Set(),files=[];
 for(const r of records)for(const file of r.files){
  const original=downloadName(r,file),dot=original.lastIndexOf('.');let name=original,n=1;
  while(used.has(name.toLowerCase()))name=original.slice(0,dot)+` (${++n})`+original.slice(dot);
  used.add(name.toLowerCase());files.push({receiptId:r.id,fileId:file.id,name:'receipts/'+name,hash:file.hash,size:file.size});
 }
 return files;
}
export const columns=[['date','Receipt date'],['merchant','Merchant'],['total','Total'],['tax','Tax'],['currency','Currency'],['category','Category'],['subtotal','Subtotal'],['tip','Tip'],['gst','GST'],['hst','HST'],['pst','PST'],['qst','QST'],['title','Receipt name'],['payer','Paid by'],['paymentType','Payment method'],['project','Project'],['purpose','Notes'],['people','Participants'],['vehicle','Vehicle'],['reimbursement','Reimbursement'],['status','Status'],['originals','Original files'],['reference','Record reference'],['created','Uploaded at']];
const value=(r,key,files)=>key==='category'?categoryNames[r.category]||'':key==='status'?r.duplicatePending?'Pending duplicate confirmation — excluded from totals':r.status==='complete'?'Filed':'Needs attention':key==='originals'?files.filter(f=>f.receiptId===r.id).map(f=>f.name).join('; '):r[key]??'';
export function receiptCsv(records,files=exportFiles(records)){
 const cell=v=>{let s=String(v??'');if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
 return '\ufeff'+[columns.map(c=>c[1]),...records.map(r=>columns.map(([key])=>value(r,key,files)))].map(row=>row.map(cell).join(',')).join('\r\n');
}
export function receiptReport(records,files,company){
 return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'"><title>Receipt details — ${html(company.name)}</title><style>body{font:15px/1.5 system-ui,sans-serif;color:#37352f;max-width:1000px;margin:40px auto;padding:0 24px}h1{font-size:28px}h2{font-size:20px;margin:0}p,small{color:#706e68}article{border-top:1px solid #ddd;padding:24px 0;break-inside:avoid}header{display:flex;justify-content:space-between;gap:20px}header strong{white-space:nowrap}dl{display:grid;grid-template-columns:150px 1fr;gap:6px 16px}dt{color:#706e68}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}a{color:#37352f}li{margin:8px 0}@media(max-width:500px){header{display:block}dl{grid-template-columns:1fr}dd{margin-bottom:8px}}@media print{body{margin:0;max-width:none}}</style><h1>${html(company.name||'Company receipts')}</h1><p>Receipt details · ${records.length} receipts. Amounts retain their original currencies. Blank fields are unknown.</p><p>Open the linked originals for printed item-level details. This report contains saved receipt fields, not a recreated invoice.</p>${records.map(r=>`<article><header><h2>${html(r.merchant||r.title||'Receipt')}</h2><strong>${html(r.currency)} ${html(r.total!==''&&r.total!=null?Number(r.total).toFixed(2):'Amount unknown')}</strong></header><p>${html(r.date||'Undated')} · ${html(categoryNames[r.category]||'Unclassified')} · ${html(value(r,'status',files))}</p><dl>${columns.filter(([k])=>!['merchant','total','currency','date','category','status','originals','reference','created'].includes(k)&&r[k]).map(([key,label])=>`<dt>${html(label)}</dt><dd>${html(r[key])}</dd>`).join('')}</dl><ul>${files.filter(f=>f.receiptId===r.id).map(f=>`<li><a href="${f.name.split('/').map(encodeURIComponent).join('/')}">${html(f.name.slice(9))}</a></li>`).join('')}</ul><small>Record reference: ${html(r.reference)} · Uploaded: ${html(r.created)}</small></article>`).join('')}</html>`;
}
