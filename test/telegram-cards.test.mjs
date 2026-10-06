import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/database.mjs';
import {TelegramInbox} from '../src/telegram.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('new card delivery edits successes, alerts exceptions, and retries safely',async()=>{
 const db=openDatabase(':memory:'),data=mkdtempSync(join(tmpdir(),'receiptbox-cards-')),calls=[];
 const id='12345678-1234-1234-1234-123456789abc';let failure=null;
 const inbox=new TelegramInbox({db,data,publicOrigin:'https://receipts.example',fetcher:async(url,options)=>{
  const method=url.split('/').at(-1),args=JSON.parse(options.body);calls.push({method,args});
  if(method==='editMessageText'&&failure)return Response.json({ok:false,error_code:failure.code,description:failure.description},{status:failure.code});
  return Response.json({ok:true,result:{message_id:301}});
 }});
 inbox.config={bot:'1',owner:'42',token:'fixture'};
 db.prepare("INSERT INTO receipts(id,number,created,updated,details) VALUES(?,1,'now','now','{}')").run(id);
 db.prepare("INSERT INTO telegram_receipts VALUES('1','42',1,?,100,'photo')").run(id);
 db.prepare("INSERT INTO telegram_cards VALUES('1','42',100,?)").run(id);
 const receipt={id,status:'complete',merchant:'Sample',total:'10',currency:'CAD'};
 try{
  assert.equal(await inbox.notifyRecognition(receipt,{id:1,status:'ready'}),true);
  assert.deepEqual(calls.map(c=>c.method),['editMessageText']);assert.match(calls[0].args.text,/blockquote/);
  assert.equal(db.prepare('SELECT message FROM telegram_notifications WHERE job=1').get().message,100);
  assert.equal(db.prepare('SELECT receipt FROM telegram_followups WHERE message=100').get().receipt,id);
  await inbox.notifyRecognition(receipt,{id:1,status:'ready'});assert.equal(calls.length,1);
  calls.length=0;
  assert.equal(await inbox.notifyRecognition({...receipt,status:'review'},{id:2,status:'failed'}),true);
  assert.deepEqual(calls.map(c=>c.method),['editMessageText','sendMessage']);assert.ok(!calls[0].args.text.includes('Reading'));
  assert.equal(calls[1].args.disable_notification,false);assert.match(calls[1].args.text,/Couldn't read/);
  calls.length=0;failure={code:503,description:'Unavailable'};
  assert.equal(await inbox.notifyRecognition(receipt,{id:3,status:'ready'}),false);
  assert.deepEqual(calls.map(c=>c.method),['editMessageText']);assert.equal(db.prepare('SELECT count(*) n FROM telegram_notifications WHERE job=3').get().n,0);
  calls.length=0;failure={code:400,description:'Bad Request: message is not modified'};
  assert.equal(await inbox.notifyRecognition(receipt,{id:3,status:'ready'}),true);assert.equal(calls.length,1);
  calls.length=0;failure={code:400,description:'Bad Request: message to edit not found'};
  assert.equal(await inbox.notifyRecognition(receipt,{id:4,status:'ready'}),true);
  assert.deepEqual(calls.map(c=>c.method),['editMessageText','sendMessage']);assert.equal(calls[1].args.disable_notification,true);
 }finally{db.close();rmSync(data,{recursive:true,force:true});}
});
