import {test} from 'node:test';import assert from 'node:assert/strict';
import {receiptFeedback,savedMessage,resultMessage,issueText} from '../public/feedback.mjs';
const receipt={reference:'RC-00001',merchant:'Sample Cafe',date:'2026-10-03',currency:'CAD',total:'48.40',category:'meals',status:'complete'};
test('normal bot results are brief, English, silent and require no confirmation',()=>{
 const result=resultMessage(receipt,{status:'ready'});assert.equal(result.silent,true);assert.equal(result.button,'Open receipt');assert.ok(result.text.includes('Filed'));assert.ok(result.text.startsWith('<b>✅ Filed</b>\n<blockquote><b>Sample Cafe</b>\n<b>CAD 48.40</b>'));assert.ok(!result.text.includes(receipt.reference));assert.ok(result.text.includes('CAD 48.40'));assert.ok(result.text.includes('Meals'));assert.ok(result.text.length<180);assert.ok(!/purpose|participants|vehicle|confirm/i.test(result.text));
 assert.ok(savedMessage(receipt.reference).includes('Saved</b> · Reading'));assert.ok(!savedMessage(receipt.reference,{duplicate:true}).includes('Organizing'));
});
test('processing and failed recognition never claim a receipt is filed',()=>{
 const pending={...receipt,status:'review'};assert.equal(receiptFeedback(pending,{status:'running'}).state,'processing');const failed=resultMessage(pending,{status:'failed'});assert.equal(failed.silent,false);assert.ok(/retry/i.test(failed.text));assert.ok(!failed.text.includes('No action needed'));
});
test('exceptions explain the action without repeating model warnings',()=>{
 const job={status:'ready',result:{assessment:{issues:[{field:'date',code:'missing'}]},warnings:['NO BUSINESS CONTEXT']}};const result=resultMessage({...receipt,status:'review',date:''},job);assert.ok(result.text.includes('<b>✏️ Add the receipt date</b>'));assert.ok(result.text.includes('Add the receipt date'));assert.ok(!result.text.includes('BUSINESS'));assert.equal(result.silent,false);assert.equal(result.button,'Open receipt');
 for(const code of ['missing','unsupported','arithmetic','future_date','tax_exceeds_total','transaction','document_kind'])assert.ok(!/[\p{Script=Han}]/u.test(issueText({code,field:'date'})));
});

test('bot HTML escapes OCR text and does not invent missing amount warnings',()=>{
 const result=resultMessage({...receipt,merchant:'Cafe <b> & Tea',total:'',status:'review',category:'other'},{status:'ready',result:{assessment:{issues:[{code:'arithmetic',field:'total'}]}}});
 assert.ok(result.text.includes('Cafe &lt;b&gt; &amp; Tea'));assert.ok(!result.text.includes('Amount needed'));assert.ok(!result.text.includes('Other'));assert.ok(result.text.includes('amounts do not add up'));
});

test('failed recognition is distinct and identifies an unread receipt without fabricating fields',()=>{
 const result=resultMessage({reference:'RC-00007',status:'review',total:'',merchant:''},{status:'failed'});
 assert.match(result.text,/Couldn't read this receipt/);assert.ok(!result.text.includes('RC-00007'));assert.match(result.text,/Photo receipt/);assert.ok(!result.text.includes('CAD'));assert.equal(result.button,'Open receipt');
});
test('receipt card separates amount, readable date and category while escaping project names',()=>{
 const result=resultMessage({...receipt,total:'71.6',category:'utilities',project:'Trip <A>'},{status:'ready'});
 assert.match(result.text,/<b>CAD 71.60<\/b>/);assert.match(result.text,/3 Oct 2026 · Utilities/);assert.match(result.text,/Project: Trip &lt;A&gt;/);
});

test('receipt identities use human names and exact duplicates show the existing state',()=>{
 const unknown={status:'review',files:[{name:'telegram-photo-123.jpg'},{name:'invoice <A>.pdf'}]};
 assert.match(resultMessage(unknown,{status:'failed'}).text,/invoice &lt;A&gt;.pdf/);
 assert.ok(!resultMessage(unknown,{status:'failed'}).text.includes('not in totals'));
 const exact=savedMessage('',{duplicate:true,receipt});assert.match(exact,/Already saved/);assert.match(exact,/Sample Cafe/);assert.match(exact,/Current status: Filed/);
 const duplicate=resultMessage({...receipt,duplicatePending:true},{status:'ready'});assert.match(duplicate.text,/🔁 Is this the same receipt/);assert.match(duplicate.text,/Excluded from totals/);assert.equal(duplicate.silent,false);
});
