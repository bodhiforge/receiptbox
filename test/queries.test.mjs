import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,transaction} from '../src/database.mjs';
import {createQueries} from '../src/queries.mjs';
import {blankDetails} from '../src/business.mjs';
import {findReceipts,searchText} from '../public/receipts.mjs';
import {dashboard} from '../public/dashboard.mjs';

function seed(db,n) {
  const records=[];
  transaction(db,()=>{
    const insert=db.prepare('INSERT INTO receipts(id,number,created,updated,details) VALUES(?,?,?,?,?)');
    const index=db.prepare('INSERT INTO receipt_search VALUES(?,?)');
    for(let i=1;i<=n;i++){
      const details={...blankDetails,title:i%3?'':`Project Alpha ${i}`,merchant:i%2?'Sample Cafe':'Sample Fuel',date:i%11?`2026-${String(i%12+1).padStart(2,'0')}-02`:'',currency:i%13?'CAD':'USD',category:i%2?'meals':'fuel',total:i%7?String(i%300):'',tax:'1.20',payer:i%2?'Alex':'Company card',project:'Client Alpha',status:i%4?'review':'complete'};
      const r={...details,id:String(i),number:i,created:`2026-10-04T12:${String(i%60).padStart(2,'0')}:00Z`,reference:`RC-${String(i).padStart(5,'0')}`,files:[],events:[]};
      insert.run(r.id,i,r.created,r.created,JSON.stringify(details));index.run(r.id,searchText(r));records.push(r);
    }
  });
  return records;
}

test('SQL search matches combined product filters and keeps page payloads bounded',()=>{
  const db=openDatabase(':memory:'),records=seed(db,200),queries=createQueries(db);
  try{
    for(const filters of [{},{search:'alpha cafe'},{category:'fuel',status:'pending'},{from:'2026-02-01',to:'2026-09-30',currency:'CAD',min:'20',max:'100'},{year:'undated'},{payer:'alex',project:'alpha',issue:'amount'},{year:'2026',month:'02',sort:'date'},{currency:'CAD',sort:'amount-low'}]){
      const expected=findReceipts(records,filters),actual=queries.list({...filters,limit:100});
      assert.equal(actual.total,expected.length,JSON.stringify(filters));
      assert.deepEqual(actual.items.map(r=>r.id),expected.slice(0,100).map(r=>r.id),JSON.stringify(filters));
      assert.ok(actual.items.every(r=>!('events' in r)&&!('ai' in r)));
    }
    const first=queries.list({limit:50}),second=queries.list({limit:50,offset:50});
    assert.equal(new Set([...first.items,...second.items].map(r=>r.id)).size,100);
    assert.deepEqual(queries.report({year:'2026',currency:'CAD'}),dashboard(records,'2026','CAD'));
    assert.equal(queries.facets().total,200);
    assert.throws(()=>queries.list({min:'1'}),/currency/);
    assert.throws(()=>queries.list({limit:'10000'}),/page/);
    assert.throws(()=>queries.list({from:'2026-02-30'}),/date/);
  }finally{db.close();}
});

test('10,000-record search meets the 300ms backend P95 budget',()=>{
  const db=openDatabase(':memory:');seed(db,10000);const queries=createQueries(db),times=[];
  try{
    for(let i=0;i<31;i++){
      const start=performance.now();
      const result=queries.list({search:'alpha cafe',currency:'CAD',from:'2026-01-01',to:'2026-12-31',sort:'amount-high',limit:50,offset:(i%4)*50});
      assert.equal(result.items.length,50);if(i)times.push(performance.now()-start);
    }
    times.sort((a,b)=>a-b);const p95=times[Math.ceil(times.length*.95)-1];
    console.log(JSON.stringify({benchmark:'10000-record-search',samples:times.length,p95Ms:Number(p95.toFixed(2)),budgetMs:300}));
    assert.ok(p95<300,`Backend search P95 was ${p95}ms`);
  }finally{db.close();}
});

test('report drill-through excludes pending duplicates without hiding ordinary inbox receipts',()=>{
 const db=openDatabase(':memory:');for(let i=1;i<=3;i++)db.prepare('INSERT INTO receipts(id,number,created,updated,details,duplicate_of) VALUES(?,?,?,?,?,?)').run('drill'+i,i,'now','now',JSON.stringify({...blankDetails,date:'2026-09-01',total:'10',tax:'0',currency:'CAD',category:'travel',project:'Trip',status:'complete'}),i===3?'drill1':null);
 const q=createQueries(db),f={status:'all',dated:'1',currency:'CAD',project:'Trip',projectExact:'1'};
 assert.equal(q.report({mode:'range',currency:'CAD',project:'Trip',group:'project'}).totals.count,2);
 assert.equal(q.list({...f,excludeDuplicates:'1'}).total,2);assert.equal(q.list({...f,excludeDuplicates:'1',offset:'1',limit:'1'}).items.length,1);
 assert.equal(q.list(f).total,3);db.close();
});
