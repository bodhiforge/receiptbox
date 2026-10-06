import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dashboard} from '../public/dashboard.mjs';
test('monthly totals use receipt dates, separate currencies and expose missing values',()=>{
 const rows=[
 {date:'2026-01-10',currency:'CAD',total:'0.10',tax:'0',category:'fuel',status:'complete'},
 {date:'2026-01-31',currency:'CAD',total:'0.20',tax:'',category:'meals',status:'missing'},
 {date:'2026-01-31',currency:'CAD',total:'',tax:'',category:'meals',status:'review',ai:{status:'ready',result:{fields:{total:{value:'100'}}}}},
 {date:'2026-02-01',currency:'CAD',total:'20.00',tax:'1',category:'',status:'review'},
 {date:'2026-01-10',currency:'USD',total:'999',tax:'0',category:'fuel',status:'complete'},
 {date:'2025-12-31',created:'2026-01-02',currency:'CAD',total:'200',tax:'0',status:'complete'},
 {date:'',currency:'CAD',total:'500',tax:'',status:'review'},
 {date:'2026-01-01',currency:'',total:'500',tax:'',status:'review'}];
 const report=dashboard(rows,'2026','CAD','01');assert.equal(report.months.length,12);assert.equal(report.months[0].total,30);assert.equal(report.months[1].total,2000);assert.equal(report.totals.total,30);assert.equal(report.totals.reviewed,10);assert.equal(report.totals.pendingAmount,20);assert.equal(report.totals.pending,2);assert.equal(report.totals.unknownTotal,1);assert.equal(report.totals.unknownTax,2);assert.equal(report.undated,1);assert.equal(report.missingCurrency,1);assert.equal(report.unaccepted,1);assert.equal(report.categories.reduce((n,c)=>n+c.total,0),30);
 assert.equal(dashboard(rows,'2026','USD').totals.total,99900);assert.equal(dashboard(rows,'2026','CAD').totals.total,2030);assert.equal(dashboard(rows,'2026','CAD','03').totals.count,0);
});
test('empty inbox and invalid dates remain explicit',()=>{
 assert.equal(dashboard([],'2026','CAD').totals.total,0);
 const report=dashboard([{date:'2026-02-30',currency:'CAD',total:'100',status:'review'}],'2026','CAD');assert.equal(report.undated,1);assert.equal(report.totals.total,0);
});

test('summary groups preserve recorded tax and distinguish unknown tax from zero',()=>{
 const rows=[{date:'2026-09-01',currency:'CAD',total:'100',tax:'5',category:'utilities',project:'Studio',status:'complete'},{date:'2026-09-02',currency:'CAD',total:'40',tax:'',category:'utilities',project:'Studio',status:'complete'},{date:'2026-09-03',currency:'CAD',total:'20',tax:'0',category:'meals',project:'Trip',status:'complete'}];
 for(const group of ['category','project','month']){const r=dashboard(rows,'','CAD','',{group});assert.equal(r.groups.reduce((n,g)=>n+g.total,0),16000);assert.equal(r.groups.reduce((n,g)=>n+g.tax,0),500);assert.equal(r.groups.reduce((n,g)=>n+g.unknownTax,0),1);}
});
