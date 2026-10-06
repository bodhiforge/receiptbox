import {receiptLabel} from './receipts.mjs';
// Shared, action-focused feedback for the archive and Telegram.
export {categoryNames as categoryText} from './categories.mjs';
import {categoryNames as categoryText} from './categories.mjs';
export const fieldText={merchant:'Merchant',date:'Receipt date',total:'Total',tax:'Tax',currency:'Currency',category:'Category',subtotal:'Subtotal',tip:'Tip',document:'Document'};
export function issueText(issue){
 const field=(fieldText[issue.field]||'this detail').toLowerCase();
 if(issue.code==='missing')return `Add the ${field}.`;
 if(issue.code==='unsupported')return `Check the ${field} against the original.`;
 if(issue.code==='future_date')return 'The date is in the future. Check the receipt date.';
 if(issue.code==='tax_exceeds_total')return 'Tax is higher than the total. Check these two amounts.';
 if(issue.code==='arithmetic')return 'The amounts do not add up. Check the subtotal, tax and total.';
 if(issue.code==='transaction')return 'This may include a refund or multiple purchases. Check the document.';
 return 'Confirm that this document represents one company expense.';
}
export function receiptFeedback(receipt,job=receipt.ai){
 if(receipt.duplicatePending)return {state:'attention',title:'Possible duplicate',detail:'Original saved. Excluded from totals until you choose Use existing or Keep both.',issues:[]};
 if(receipt.status==='complete')return {state:'filed',title:'Filed',detail:'Included in your totals. You can edit it anytime.',issues:[]};
 if(['queued','running'].includes(job?.status)||receipt.processing)return {state:'processing',title:'Saved. Organizing now.',detail:'Your original is safe. You can leave this page.',issues:[]};
 if(job?.status==='failed')return {state:'attention',title:'Saved. Recognition needs a retry.',detail:'Your original is safe. Retry recognition or enter the details.',issues:[]};
 const issues=job?.result?.assessment?.issues||[];
 return {state:'attention',title:issues.length===1?'Check one detail':issues.length?`Check ${issues.length} details`:'A few details are missing',detail:issues.length?'Everything else is saved. Only check the items below.':'Add date, total and currency to file this receipt.',issues};
}
// Telegram HTML is escaped at the boundary; receipt text is untrusted OCR/user input.
export const escapeHtml=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const short=value=>String(value||'').replace(/[\r\n]+/g,' ').slice(0,160);
export function receiptCard(receipt){
 const filename=receipt.files?.find(f=>f.name&&!/^telegram-photo-\d+\./.test(f.name))?.name;
 const identity=short(receipt.title||receipt.merchant||receipt.category?receiptLabel(receipt):filename||'Photo receipt');
 const lines=[`<b>${escapeHtml(identity)}</b>`];
 if(receipt.total!==''&&receipt.total!=null){
  const n=Number(receipt.total),amount=Number.isFinite(n)?n.toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2}):receipt.total;
  lines.push(`<b>${escapeHtml([receipt.currency,amount].filter(Boolean).join(' '))}</b>`);
 }
 const m=String(receipt.date||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
 const date=m?`${Number(m[3])} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m[2])-1]} ${m[1]}`:receipt.date;
 const metadata=[date,receipt.category==='other'?null:categoryText[receipt.category]].filter(Boolean);
 if(metadata.length)lines.push(escapeHtml(metadata.join(' · ')));
 if(receipt.project)lines.push(`Project: ${escapeHtml(short(receipt.project))}`);
 return `<blockquote>${lines.join('\n')}</blockquote>`;
}
export function savedMessage(reference,{duplicate=false,processing=true,receipt}={}){
 if(duplicate)return ['↩️ <b>Already saved</b>',receipt?receiptCard(receipt):'',receipt?`Current status: ${escapeHtml(receiptFeedback(receipt).title)}`:'','This exact file is already in your archive. No new receipt was added.'].filter(Boolean).join('\n');
 return processing?'📥 <b>Saved</b> · Reading…':'📥 <b>Saved</b>';
}
export function resultMessage(receipt,job){
 const status=receiptFeedback(receipt,job);
 const failed=job?.status==='failed'&&status.state!=='filed'&&!receipt.duplicatePending;
 const single=status.issues.length===1?status.issues[0]:null;
 const prompts={date:'date: YYYY-MM-DD',total:'total: AMOUNT',merchant:'merchant: Store name',currency:'currency: CURRENCY',tax:'tax: AMOUNT'};
 const action=single?.code==='missing'?issueText(single).replace(/\.$/,''):single?.code==='arithmetic'?'Check the amounts':status.issues.length>1?`Check ${status.issues.length} details`:'Check receipt details';
 const title=receipt.duplicatePending?'🔁 Is this the same receipt?':status.state==='filed'?'✅ Filed':status.state==='processing'?'📥 Saved · Reading…':failed?"❗ Couldn't read this receipt":`✏️ ${action}`;
 const text=[`<b>${escapeHtml(title)}</b>`,receiptCard(receipt)];
 if(receipt.duplicatePending)text.push('Excluded from totals until you choose.');
 else if(failed)text.push('Original saved. Open the receipt to retry or enter details.');
 else if(status.state==='attention'){
  if(single?.code==='missing'&&prompts[single.field])text.push(`Reply with your value: <code>${escapeHtml(prompts[single.field])}</code>`);
  else text.push(...(status.issues.length?[...new Set(status.issues.map(issueText))].map(t=>`• ${escapeHtml(t)}`):[escapeHtml(status.detail)]));
 }
 if(receipt.possibleDuplicate&&!receipt.duplicatePending)text.push('Looks similar to a receipt already saved. Both are counted.');
 return {text:text.join('\n'),silent:status.state==='filed'&&!receipt.possibleDuplicate,button:receipt.duplicatePending?'Compare receipts':'Open receipt'};
}
