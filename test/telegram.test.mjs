import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/database.mjs';
import {mkdtempSync,rmSync,statSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TelegramInbox} from '../src/telegram.mjs';

test('private Telegram pairing, exact bytes, duplicate handling and purpose replies',async()=>{
  const data=mkdtempSync(join(tmpdir(),'receiptbox-bot-test-'));
  const db=openDatabase(':memory:');
  const calls=[],purposes=[];let imports=0,replyId=100;
  const bytes=Buffer.from('%PDF-1.4\nSample');
  const fetcher=async(url,options)=>{
    if(url.includes('/file/'))return new Response(bytes);
    const method=url.split('/').at(-1),args=JSON.parse(options.body);calls.push({method,args});
    const result=method==='getMe'?{is_bot:true,id:123,username:'sample_receipt_bot'}:method==='getWebhookInfo'?{url:''}:method==='getFile'?{file_path:'documents/sample.pdf'}:method==='sendMessage'?{message_id:replyId++}:[];
    return Response.json({ok:true,result});
  };
  const inbox=new TelegramInbox({db,data,publicOrigin:'https://mini.example',fetcher,
    ingest:async(content)=>{assert.deepEqual(content,bytes);imports++;db.prepare("INSERT INTO receipts(id,number,created,updated,details) VALUES(?,?,'now','now','{}')").run('sample-id',1);return {duplicate:false,receipt:{id:'sample-id'}};},
    updatePurpose:async(id,text)=>purposes.push({id,text})});
  try {
    await inbox.configure('123:abcdefghijklmnopqrstuv');assert.equal(statSync(join(data,'telegram-private.json')).mode&0o777,0o600);
    assert.ok(!JSON.stringify(inbox.status()).includes('abcdefghijklmnopqrstuv'));
    const pairing=inbox.config.pairing;
    const message=(id,from,text,extra={})=>({update_id:id,message:{message_id:id,chat:{id:from,type:'private'},from:{id:from,is_bot:false},text,...extra}});
    await inbox.handle(message(1,999,'/start'));assert.equal(inbox.config.owner,null);
    await inbox.handle(message(2,42,`/start pair_${pairing}`));assert.equal(inbox.config.owner,'42');assert.equal(inbox.config.pairing,null);
    const before=calls.length;
    await inbox.handle(message(3,999,'',{document:{file_id:'x',file_size:15}}));assert.equal(calls.length,before);assert.equal(imports,0);
    const doc=message(4,42,'',{document:{file_id:'x',file_size:15,file_name:'sample.pdf',mime_type:'application/pdf'},caption:'Sample project lunch'});
    await inbox.handle(doc);assert.equal(imports,1);assert.equal(purposes[0].text,'Sample project lunch');
    const saved=db.prepare('SELECT * FROM telegram_receipts').get();assert.ok(saved.reply);assert.equal(db.prepare('SELECT message FROM telegram_cards').get().message,saved.reply);
    assert.ok(calls.find(c=>c.method==='sendMessage'&&c.args.text.includes('Saved')));
    await inbox.handle(doc);assert.equal(imports,1);
    await inbox.handle(message(5,42,'Project lunch with Alex',{reply_to_message:{message_id:saved.reply}}));
    assert.equal(purposes.at(-1).text,'Project lunch with Alex');
    assert.equal(JSON.parse(readFileSync(join(data,'telegram-private.json'))).owner,'42');
    const reloaded=new TelegramInbox({db,data,publicOrigin:'https://mini.example',fetcher});assert.equal(reloaded.status().paired,true);
    await assert.rejects(()=>inbox.configure('123:abcdefghijklmnopqrstuv'),/already connected/);
  } finally {db.close();rmSync(data,{recursive:true,force:true});}
});

test('recognition buttons require paired sender, mapped message and current record version',async()=>{
 const data=mkdtempSync(join(tmpdir(),'receiptbox-callback-')),db=openDatabase(':memory:');
 
 const id='12345678-1234-1234-1234-123456789abc';db.prepare("INSERT INTO receipts(id,number,created,updated,details) VALUES(?,1,'now','now','{}')").run(id);
 let accepted=0;const calls=[];
 const inbox=new TelegramInbox({db,data,publicOrigin:'https://mini.example',getReceipt:()=>({id,reference:'RC-00001',version:4,purpose:'',files:[]}),acceptRecognition:(target,job,version)=>{assert.equal(target,id);assert.equal(job,2);if(version!==4)throw Object.assign(Error('changed'),{status:409});accepted++;},fetcher:async(url,options)=>{calls.push({method:url.split('/').at(-1),args:JSON.parse(options.body)});return Response.json({ok:true,result:{message_id:300}});}});
 inbox.config={bot:'1',owner:'42',token:'fixture'};
 db.prepare("INSERT INTO telegram_receipts VALUES('1','42',1,?,100,'document')").run(id);
 const callback=(sender=42,message=100,version=4)=>({callback_query:{id:'query',from:{id:sender},message:{message_id:message,chat:{id:42,type:'private'}},data:`accept:2:${version}:${id}`}});
 try{
  await inbox.handle(callback(99));await inbox.handle(callback(42,999));assert.equal(accepted,0);assert.equal(calls.length,0);
  await inbox.handle(callback(42,100,3));assert.equal(accepted,0);
  await inbox.handle(callback());assert.equal(accepted,1);assert.ok(calls.find(c=>c.method==='sendMessage'&&c.args.text.includes('Check receipt details')));
  assert.equal(db.prepare('SELECT count(*) n FROM telegram_followups').get().n,1);
 }finally{db.close();rmSync(data,{recursive:true,force:true});}
});

test('local recognition sends one durable result, not an edit of a ForceReply acknowledgement',async()=>{
 const data=mkdtempSync(join(tmpdir(),'receiptbox-delivery-')),db=openDatabase(':memory:');
 
 const id='12345678-1234-1234-1234-123456789abc';db.prepare("INSERT INTO receipts(id,number,created,updated,details) VALUES(?,1,'now','now','{}')").run(id);
 const calls=[],updates=[];let failSend=true;
 const inbox=new TelegramInbox({db,data,publicOrigin:'https://mini.example',updatePurpose:async(target,text)=>updates.push({target,text}),fetcher:async(url,options)=>{
   const method=url.split('/').at(-1),args=JSON.parse(options.body);calls.push({method,args});
   if(method==='editMessageText')return Response.json({ok:false,error_code:400,description:"Bad Request: message can't be edited"},{status:400});
   if(failSend)return Response.json({ok:false,error_code:500},{status:500});
   return Response.json({ok:true,result:{message_id:301}});
 }});
 inbox.config={bot:'1',owner:'42',token:'fixture'};
 db.prepare("INSERT INTO telegram_receipts VALUES('1','42',1,?,100,'document')").run(id);
 const receipt={id,reference:'RC-00001',version:1,status:'complete',merchant:'Sample Cafe',total:'48.40',currency:'CAD'};
 const job={id:5,status:'ready',result:{fields:Object.fromEntries(['merchant','date','total','tax','currency','category'].map(k=>[k,{value:'',confidence:'low'}])),warnings:[]}};
 try{
  assert.equal(await inbox.notifyRecognition(receipt,job),false);assert.match(inbox.status().error,/delivery is retrying/);assert.equal(db.prepare('SELECT count(*) n FROM telegram_notifications').get().n,0);
  failSend=false;assert.equal(await inbox.notifyRecognition(receipt,job),true);assert.equal(inbox.status().error,null);
  const before=calls.length;assert.equal(await inbox.notifyRecognition(receipt,job),true);assert.equal(calls.length,before);
  assert.ok(calls.every(c=>c.method==='sendMessage'));assert.equal(calls.at(-1).args.reply_markup.inline_keyboard[0][0].url,`https://mini.example/#receipt=${id}`);assert.ok(!calls.at(-1).args.text.includes('参与人:'));
  assert.equal(calls.at(-1).args.disable_notification,true);assert.ok(calls.at(-1).args.text.includes('Filed'));
  assert.equal(db.prepare('SELECT message FROM telegram_notifications').get().message,301);
  assert.equal(db.prepare('SELECT receipt FROM telegram_followups WHERE message=301').get().receipt,id);
  await inbox.handle({message:{message_id:302,chat:{id:42,type:'private'},from:{id:42},text:'Client meeting',reply_to_message:{message_id:301}}});assert.deepEqual(updates,[{target:id,text:'Client meeting'}]);
  assert.equal(calls.find(c=>c.args.reply_parameters)?.args.reply_parameters.allow_sending_without_reply,true);
 }finally{db.close();rmSync(data,{recursive:true,force:true});}
});

test('possible duplicate delivery links existing receipt without changing saved receipt',async()=>{
 const data=mkdtempSync(join(tmpdir(),'receiptbox-duplicate-message-')),db=openDatabase(':memory:');const calls=[];
 const id='12345678-1234-1234-1234-123456789abc',existing='87654321-1234-1234-1234-123456789abc';
 const inbox=new TelegramInbox({db,data,publicOrigin:'https://receipts.example',fetcher:async(url,options)=>{calls.push(JSON.parse(options.body));return Response.json({ok:true,result:{message_id:500}});}});inbox.config={bot:'1',owner:'42',token:'fixture'};
 try{db.prepare("INSERT INTO receipts(id,number,created,updated,details) VALUES(?,1,'now','now','{}')").run(id);db.prepare("INSERT INTO telegram_receipts VALUES('1','42',1,?,100,'document')").run(id);
 const r={id,status:'complete',merchant:'Cafe',date:'2026-10-04',total:'70',currency:'CAD',possibleDuplicate:{id:existing}};
 assert.equal(await inbox.notifyRecognition(r,{id:42,status:'ready'}),true);assert.match(calls[0].text,/Looks similar/);assert.equal(calls[0].reply_markup.inline_keyboard[0][0].url,`https://receipts.example/#receipt=${existing}`);assert.equal(calls[0].reply_markup.inline_keyboard[1][0].url,`https://receipts.example/#receipt=${id}`);assert.equal(r.status,'complete');
 await inbox.notifyRecognition(r,{id:42,status:'ready'});assert.equal(calls.length,1);
 }finally{db.close();rmSync(data,{recursive:true,force:true});}
});

test('duplicate confirmation buttons require authorized owner and mapped message',async()=>{
 const data=mkdtempSync(join(tmpdir(),'receiptbox-duplicate-actions-')),db=openDatabase(':memory:');let resolved=0;const calls=[];
 const id='12345678-1234-1234-1234-123456789abc';
 const inbox=new TelegramInbox({db,data,publicOrigin:'https://receipts.example',resolveDuplicate:(target,version,choice)=>{assert.equal(target,id);assert.equal(version,3);assert.equal(choice,'keep');resolved++;},fetcher:async(url,options)=>{calls.push(JSON.parse(options.body));return Response.json({ok:true,result:{}});}});inbox.config={bot:'1',owner:'42',token:'fixture'};
 try{db.prepare("INSERT INTO receipts(id,number,created,updated,details) VALUES(?,1,'now','now','{}')").run(id);db.prepare("INSERT INTO telegram_followups VALUES('1','42',100,?)").run(id);
 const cb=(sender,message)=>({callback_query:{id:'q',from:{id:sender},message:{message_id:message,chat:{id:sender,type:'private'}},data:`dup:k:3:${id}`}});
 await inbox.handle(cb(99,100));await inbox.handle(cb(42,999));assert.equal(resolved,0);await inbox.handle(cb(42,100));assert.equal(resolved,1);assert.match(calls[0].text,/Both receipts kept/);assert.match(calls[1].text,/Kept both/);assert.deepEqual(calls[1].reply_markup.inline_keyboard,[]);
 const buttons=inbox.resultButtons({id,version:3,duplicatePending:true,possibleDuplicate:{id:'older'}},{button:'Review receipt'});assert.deepEqual(buttons[0].map(b=>b.text),['Use existing','Keep both']);assert.ok(buttons[0].every(b=>Buffer.byteLength(b.callback_data)<=64));
 }finally{db.close();rmSync(data,{recursive:true,force:true});}
});
