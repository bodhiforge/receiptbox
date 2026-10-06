import {test} from 'node:test';import assert from 'node:assert/strict';
import {openDatabase} from '../src/database.mjs';import {createProjects} from '../src/projects.mjs';import {blankDetails} from '../src/business.mjs';import {createQueries} from '../src/queries.mjs';
test('project management preserves legacy names, exact filtering, currency totals and audit history',()=>{
 const db=openDatabase(':memory:');const projects=createProjects(db),q=createQueries(db);
 try{
  projects.create('Toronto trip');projects.create('Toronto trip extended');assert.throws(()=>projects.create('toronto TRIP'),/exists/);
  for(const reserved of ['Default',' default ','DEFAULT'])assert.throws(()=>projects.create(reserved),/reserved/);
  assert.throws(()=>projects.rename('Toronto trip extended','Default'),/reserved/);
  for(const [i,currency,total,deleted] of [[1,'CAD','70',false],[2,'USD','10',false],[3,'CAD','90',true]])db.prepare('INSERT INTO receipts(id,number,created,updated,details,deleted_at) VALUES(?,?,?,?,?,?)').run(String(i),i,'now','now',JSON.stringify({...blankDetails,project:'Toronto trip',merchant:'Cafe',currency,total,date:'2026-10-01',status:'complete'}),deleted?'now':null);
  db.prepare('INSERT INTO receipts(id,number,created,updated,details) VALUES(?,?,?,?,?)').run('4',4,'now','now',JSON.stringify({...blankDetails,project:'Legacy project'}));
  assert.ok(projects.list().some(p=>p.name==='Legacy project'));const trip=projects.list().find(p=>p.name==='Toronto trip');assert.equal(trip.count,2);assert.deepEqual(trip.totals.map(g=>[g.currency,g.total]),[['CAD','70.00'],['USD','10.00']]);
  assert.equal(q.list({project:'Toronto trip',projectExact:'1'}).total,2);assert.equal(q.report({year:'2026',currency:'CAD',project:'Toronto trip'}).totals.count,1);assert.equal(q.report({year:'2026',currency:'CAD',project:'missing'}).totals.count,0);
  assert.equal(q.list({project:'Toronto',projectExact:'1'}).total,0);
  projects.rename('Toronto trip','October travel');assert.equal(q.list({project:'October travel',projectExact:'1'}).total,2);assert.equal(q.list({project:'October travel',projectExact:'1',status:'trash'}).total,1);assert.equal(q.list({search:'October travel'}).total,2);
  assert.equal(db.prepare('SELECT version FROM receipts WHERE id=?').get('1').version,2);assert.equal(db.prepare("SELECT count(*) n FROM events WHERE type='edited'").get().n,3);
  assert.throws(()=>projects.remove('October travel'),/receipts/);projects.remove('Toronto trip extended');assert.ok(!projects.list().some(p=>p.name==='Toronto trip extended'));
 }finally{db.close();}
});
