import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/database.mjs';
import {possibleDuplicate} from '../src/duplicates.mjs';
import {resultMessage} from '../public/feedback.mjs';
test('duplicate hints match older merchant/date/amount/currency only and never mutate receipts',()=>{
 const db=openDatabase(':memory:');const base={merchant:'Sample Cafe',date:'2026-10-04',total:'70.00',currency:'CAD',status:'complete'};
 try{db.prepare("INSERT INTO receipts(id,number,created,updated,details) VALUES('older',1,'now','now',?)").run(JSON.stringify(base));
 const newer={...base,id:'newer',number:2,merchant:'SAMPLE CAFE!',total:'70'};assert.equal(possibleDuplicate(db,newer).id,'older');
 for(const patch of [{date:'2026-10-03'},{currency:'USD'},{total:'71'},{merchant:'Other cafe'},{merchant:''},{total:''},{number:1},{deleted_at:'now'}])assert.equal(possibleDuplicate(db,{...newer,...patch}),null);
 assert.equal(db.prepare('SELECT details FROM receipts').get().details,JSON.stringify(base));
 const msg=resultMessage({...newer,possibleDuplicate:{id:'older'}},{status:'ready'});assert.match(msg.text,/Looks similar/);assert.match(msg.text,/Filed/);assert.equal(msg.silent,false);
 db.prepare("UPDATE receipts SET deleted_at='now'").run();assert.equal(possibleDuplicate(db,newer),null);
 }finally{db.close();}
});
