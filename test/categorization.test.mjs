import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/database.mjs';
import {rememberedCategory,improveCategory} from '../src/categorization.mjs';
const result=(merchant,category=null)=>({fields:{merchant:{value:merchant},total:{value:'20.00'},category:{value:category,confidence:'low',evidence:''}}});
test('merchant memory requires explicit consistent human edits, excludes mixed retailers and trash',()=>{
 const db=openDatabase(':memory:');let number=0;
 const add=(merchant,category,human=true,deleted=null)=>{const id=String(++number);db.prepare('INSERT INTO receipts(id,number,created,updated,details,deleted_at) VALUES(?,?,?,?,?,?)').run(id,number,'now','now',JSON.stringify({merchant,category}),deleted);if(human)db.prepare('INSERT INTO events(receipt_id,created,type,details) VALUES(?,?,?,?)').run(id,'now','edited',JSON.stringify({category:{from:'other',to:category}}));return id;};
 add('Example Electric','utilities',false);assert.equal(rememberedCategory(db,'Example Electric'),null);
 add('Example Electric','utilities');assert.equal(rememberedCategory(db,'Example Electric').value,'utilities');
 add('Example Electric','office',true,'now');assert.equal(rememberedCategory(db,'Example Electric').value,'utilities');
 add('Example Electric','office');assert.equal(rememberedCategory(db,'Example Electric'),null);
 add('Costco Wholesale','office');assert.equal(rememberedCategory(db,'Costco Wholesale'),null);
 db.close();
});
test('provider and remembered categories avoid extra model calls',async()=>{
 const request=()=>{throw Error('must not request');};
 const r=await improveCategory(result('BC Hydro'),{request});assert.equal(r.fields.category.value,'utilities');assert.equal(r.fields.total.value,'20.00');
 const m=await improveCategory(result('Example Cafe'),{request,remember:()=>({value:'meals',confidence:'high',evidence:'Your saved category',source:'merchant_memory'})});assert.equal(m.fields.category.source,'merchant_memory');
 const known=result('Hotel','travel');known.fields.category={value:'travel',confidence:'high',evidence:'Room'};assert.equal(await improveCategory(known,{request,ocr:'Room'}),known);
});
test('category-only retry is local, text-only, bounded, and evidence backed',async()=>{
 let calls=0;const original=result('Example');
 const request=async(url,args)=>{calls++;assert.equal(url,'http://127.0.0.1:11434/api/chat');const b=JSON.parse(args.body);assert.equal(b.messages.some(m=>m.images),false);assert.equal(b.options.num_predict,256);return {ok:true,json:async()=>({done_reason:'stop',message:{content:JSON.stringify({category:'utilities',evidence:'Electricity charges'})}})};};
 const r=await improveCategory(original,{ocr:'Electricity charges 20.00',request});assert.equal(calls,1);assert.equal(r.fields.category.value,'utilities');assert.equal(r.fields.total,original.fields.total);
 assert.equal(await improveCategory(original,{ocr:'Unknown purchase',request}),original);
 assert.equal(await improveCategory(original,{ocr:'Electricity',request:async()=>{throw Error('timeout');}}),original);
});

test('category retry uses the shared image model configuration with thinking disabled',async()=>{
 const {receiptModel}=await import('../src/local-model.mjs');let body;
 await improveCategory(result('Example'),{ocr:'Electricity charge',request:async(_url,options)=>{body=JSON.parse(options.body);return {ok:true,json:async()=>({message:{content:JSON.stringify({category:'utilities',evidence:'Electricity charge'})}})};}});
 assert.equal(body.model,receiptModel);assert.equal(receiptModel,'qwen3.5:4b');assert.equal(body.think,false);
});
