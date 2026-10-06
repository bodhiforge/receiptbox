import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dashboard} from '../public/dashboard.mjs';
test('spending ranges cross years and group dynamically without combining currencies',()=>{
 const rows=[{date:'2025-12-31',currency:'CAD',total:'10',category:'travel',project:'Trip',status:'complete'},{date:'2026-01-02',currency:'CAD',total:'20',category:'office',project:'Work',status:'complete'},{date:'2026-01-02',currency:'USD',total:'999'},{date:'',currency:'CAD',total:'100'}];
 let r=dashboard(rows,'','CAD','',{from:'2025-12-01',to:'2026-01-31',group:'year'});assert.equal(r.totals.total,3000);assert.deepEqual(r.groups.map(g=>[g.key,g.total]),[['2025',1000],['2026',2000]]);
 r=dashboard(rows,'','CAD','',{from:'2026-01-01',group:'project'});assert.equal(r.totals.count,1);assert.equal(r.groups[0].key,'Work');assert.equal(r.undated,1);
});
