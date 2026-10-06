import {test} from 'node:test';
import assert from 'node:assert/strict';
import {receiptName,findReceipts,filterError} from '../public/receipts.mjs';
const rows=[
 {id:'a',number:1,reference:'RC-00001',created:'2026-10-04T00:00:00Z',date:'2026-09-30',merchant:'Sample Cafe',total:'70.00',currency:'CAD',category:'meals',status:'complete',payer:'Company card',project:'Client Alpha',purpose:'Design review',files:[{name:'IMG_001.jpg'}]},
 {id:'b',number:2,reference:'RC-00002',created:'2026-10-05T00:00:00Z',date:'2026-10-01',merchant:'Sample Fuel',total:'100.00',currency:'CAD',category:'fuel',status:'review',payer:'Alex',project:'Client Beta',files:[]},
 {id:'c',number:3,reference:'RC-00003',created:'2026-10-06T00:00:00Z',date:'',total:'',currency:'',category:'',status:'missing',files:[],ai:{id:7,status:'ready',result:{fields:{total:{value:'999'}}}},events:[]},
 {id:'d',number:4,reference:'RC-00004',created:'2026-10-07T00:00:00Z',date:'2026-10-02',total:'500.00',currency:'USD',category:'fuel',status:'review',files:[]}
];
test('receipt names use saved facts or an honest fallback, respecting custom titles',()=>{
 assert.equal(receiptName(rows[0]),'2026-09-30 · Sample Cafe · CAD 70.00 · RC-00001');
 assert.equal(receiptName({...rows[0],title:'My client meeting'}),'My client meeting');
 assert.equal(receiptName(rows[2]),'Uploaded 2026-10-06 · Receipt · RC-00003');
});
test('combined filters match tokens across fields and exclude unknown values from numeric/date ranges',()=>{
 assert.deepEqual(findReceipts(rows,{search:'alpha cafe design'}).map(r=>r.id),['a']);
 assert.deepEqual(findReceipts(rows,{search:'IMG_001'}).map(r=>r.id),['a']);
 assert.deepEqual(findReceipts(rows,{status:'pending',currency:'CAD',from:'2026-10-01',to:'2026-10-31',min:'90',max:'110',payer:'ale',project:'beta'}).map(r=>r.id),['b']);
 assert.deepEqual(findReceipts(rows,{year:'undated',issue:'recognition'}).map(r=>r.id),['c']);
 assert.deepEqual(findReceipts(rows,{category:'unclassified'}).map(r=>r.id),['c']);
 assert.deepEqual(findReceipts(rows,{currency:'CAD',sort:'amount-high'}).map(r=>r.id),['b','a']);
 assert.deepEqual(findReceipts(rows,{from:'2026-10-01'}).map(r=>r.id),['d','b']);
 assert.equal(findReceipts(rows,{search:'missingword'}).length,0);
 assert.equal(findReceipts(rows,{}).length,4);
 assert.match(filterError({min:'5',max:'1',currency:'CAD'}),/minimum/);
 assert.match(filterError({from:'2026-10-02',to:'2026-10-01'}),/start date/);
 assert.match(filterError({min:'5'}),/currency/);
 assert.equal(filterError({min:'0',max:'100',currency:'CAD'}),'');
});

test('calendar shortcuts handle year boundaries and remain named after reload',async()=>{
 const {calendarRange,datePreset}=await import('../public/receipts.mjs');
 assert.deepEqual(calendarRange('last-month',new Date(2026,0,15)),{from:'2025-12-01',to:'2025-12-31'});
 assert.deepEqual(calendarRange('this-month',new Date(2024,1,15)),{from:'2024-02-01',to:'2024-02-29'});
 assert.equal(datePreset({from:'2026-09-01',to:'2026-09-30'},new Date(2026,9,4)),'last-month');
});
