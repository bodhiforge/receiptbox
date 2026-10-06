// Deliberately isolated integration check. Never point this at the live service.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {snapshot} from '../src/backup.mjs';
const base='http://127.0.0.1:4319';
const get=async(path,options={})=>{const r=await fetch(base+path,{...options,headers:{'X-Receiptbox':'1',...options.headers}});const j=await r.json();assert.ok(r.ok,JSON.stringify(j));return j;};
assert.equal((await get('/api/config')).privateRemote,false);
assert.equal((await get('/api/receipts')).total,0,'Only an empty isolated integration store is allowed');
const bytes=await readFile('sample-receipt.pdf');const form=new FormData();form.append('file',new Blob([bytes]),'fictional-receipt.pdf');
let r=(await get('/api/receipts',{method:'POST',body:form})).receipt;assert.equal(r.merchant,'');assert.equal(r.ai.status,'queued');
const started=Date.now();
while(Date.now()-started<180000){await new Promise(resolve=>setTimeout(resolve,3000));r=await get('/api/receipts/'+r.id);if(['ready','failed'].includes(r.ai.status))break;}
assert.equal(r.ai.status,'ready',r.ai.error);assert.equal(r.merchant,'','Suggestions must not be auto-applied');
assert.equal(r.ai.result.fields.total.value,'70.00');assert.equal(r.ai.result.fields.tax.value,'3.00');assert.equal(r.ai.result.fields.tip.value,'7.00');assert.equal(r.ai.result.fields.gst.value,'');
r=await get(`/api/receipts/${r.id}/recognition`,{method:'POST',body:JSON.stringify({action:'accept',job:r.ai.id,version:r.version})});
assert.equal(r.category,'meals');assert.equal(r.total,'70.00');assert.equal(r.status,'review');
r=await get(`/api/receipts/${r.id}`,{method:'PATCH',body:JSON.stringify({...r,purpose:'Fictional project planning',payer:'Fictional company card',people:'Test Person, fictional client',status:'complete'})});
assert.equal(r.status,'complete');
const zip=await fetch(base+'/api/export.zip');assert.equal(zip.status,200);await writeFile('integration-export.zip',Buffer.from(await zip.arrayBuffer()));
const summary=await get('/api/summary');assert.equal(summary.groups[0].total,'70.00');assert.equal(summary.unfinished.length,0);
const recovery=await snapshot(process.cwd()+'/integration-data');assert.equal(recovery.receipts,1);assert.equal(recovery.files,1);
console.log(JSON.stringify({localRecognitionSeconds:(Date.now()-started)/1000,recognition:'passed',confirmation:'passed',export:'passed',verifiedRecovery:recovery}));
