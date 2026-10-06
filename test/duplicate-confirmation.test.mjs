import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/database.mjs';
import {createReceiptService} from '../src/receipts.mjs';
import {createQueries} from '../src/queries.mjs';
import {createProjects} from '../src/projects.mjs';
import {summarise} from '../src/business.mjs';
import {receiptCsv} from '../src/exports.mjs';
test('duplicate confirmation excludes totals, keeps both explicitly, and trashes/restores safely',async()=>{
 const data=mkdtempSync(join(tmpdir(),'duplicate-confirm-')),db=openDatabase(':memory:');
 const recognition={enqueue(){},latest(){return null;}};const service=createReceiptService({db,data,recognition}),queries=createQueries(db);
 async function make(n){let r=(await service.ingest({bytes:Buffer.from('%PDF-1.4\nfixture '+n),name:n+'.pdf'})).receipt;return service.update(r.id,{...r,merchant:'Sample Cafe',date:'2026-10-04',total:'70.00',currency:'CAD',tax:'3.33',category:'meals',project:'Sample trip',status:'complete'});}
 const total=()=>queries.report({mode:'range',currency:'CAD',group:'category'}).totals.total;
 try{
 const a=await make(1),b=await make(2);assert.equal(b.duplicatePending,true);assert.equal(b.status,'review');assert.equal(total(),7000);
 assert.equal(queries.facets().pending,1);assert.equal(queries.facets().complete,1);assert.equal(queries.list({status:'pending'}).items[0].id,b.id);
 assert.equal(createProjects(db).list()[0].totals[0].total,'70.00');assert.equal(summarise([service.get(a.id),b])[0].total,'70.00');assert.match(receiptCsv([b],[]),/Pending duplicate confirmation/);
 const kept=service.resolveDuplicate(b.id,b.version,'keep');assert.equal(kept.duplicatePending,false);assert.equal(kept.status,'complete');assert.equal(total(),14000);assert.throws(()=>service.resolveDuplicate(b.id,b.version,'keep'),/changed/);
 createReceiptService({db,data,recognition});assert.equal(service.get(b.id).duplicatePending,false);
 const c=await make(3),trashed=service.resolveDuplicate(c.id,c.version,'existing');assert.ok(trashed.deleted_at);assert.equal(trashed.files.length,1);assert.equal(total(),14000);assert.equal(trashed.events[0].type,'duplicate_resolved');
 const restored=service.setDeleted(c.id,trashed.version,false);assert.equal(restored.duplicatePending,true);assert.equal(total(),14000);
 const old=service.get(a.id);service.setDeleted(old.id,old.version,true);assert.equal(service.get(c.id).possibleDuplicate.id,b.id);assert.throws(()=>service.resolveDuplicate(c.id,restored.version,'existing'),/changed/);
 const current=service.get(c.id);service.resolveDuplicate(current.id,current.version,'keep');assert.equal(total(),14000);
 }finally{db.close();rmSync(data,{recursive:true,force:true});}
});
