import {test} from 'node:test';import assert from 'node:assert/strict';
import {sortedGroups,summaryCSV} from '../public/reporting.mjs';
const groups=[{key:'marketing',total:3000,tax:100,count:1,unknownTax:0},{key:'fuel',total:5000,tax:200,count:2,unknownTax:1}];
const report={groups,totals:{total:8000,tax:300,count:3,unknownTax:1}};
const base={report,group:'category',currency:'CAD',params:{from:'2026-09-01',to:'2026-09-30',project:'Trip',category:'marketing'},view:'table'};
test('name sorting uses visible labels and never mutates server group indices',()=>{
 assert.deepEqual(sortedGroups(groups,'category','name','asc').map(g=>g.key),['marketing','fuel']);
 assert.deepEqual(sortedGroups(groups,'category','name','desc').map(g=>g.key),['fuel','marketing']);
 assert.deepEqual(groups.map(g=>g.key),['marketing','fuel']);
});
test('CSV follows table sort and contains share, totals, missing tax and readable filter labels',()=>{
 const csv=summaryCSV(base,'name','asc');assert.ok(csv.indexOf('Advertising & marketing')<csv.indexOf('Fuel'));
 assert.ok(csv.includes('"37.5"'));assert.ok(csv.includes('"category","Total","Total","3","80.00","3.00","100.0","1"'));
 assert.ok(csv.includes('"Trip","Advertising & marketing"'));
 assert.ok(summaryCSV(base,'total','desc').indexOf('"Fuel"')<summaryCSV(base,'total','desc').indexOf('"Advertising & marketing"'));
});
test('Overview exports both groupings with separately labelled totals and safely quotes cells',()=>{
 const trend={...report,groups:[{key:'2026-09',total:8000,tax:300,count:3,unknownTax:1}]};
 const csv=summaryCSV({...base,view:'overview',trend,params:{project:'\t=1+2'}});assert.ok(csv.includes('"month","Detail","2026-09"'));assert.equal((csv.match(/"Total","Total"/g)||[]).length,2);assert.ok(csv.includes('"\'\t=1+2"'));
});
