import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Members,canManageMembers} from '../src/members.mjs';
import {TelegramInbox} from '../src/telegram.mjs';
import {openDatabase} from '../src/database.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('invites expire, revoke, redeem once and preserve owner across restarts',()=>{
 const db=openDatabase(':memory:');let now=100;const config={bot:'1',owner:'42',username:'fixture_bot'};const members=new Members(db,()=>config,()=>now);const token=link=>link.split('join_')[1];
 try{
 assert.equal(members.authorized('42'),true);assert.equal(members.authorized('99'),false);
 let invite=members.invite();assert.equal(members.valid(token(invite.link)),true);assert.equal(JSON.stringify(members.list()).includes(token(invite.link)),false);
 assert.equal(members.join(token(invite.link),'99','Partner'),true);assert.equal(members.authorized('99'),true);assert.throws(()=>members.join(token(invite.link),'88','Other'),/expired/);
 members.remove('99');assert.equal(members.authorized('99'),false);assert.throws(()=>members.remove('42'),/owner/);
 invite=members.invite();members.revoke(members.list().invites[0].id);assert.equal(members.valid(token(invite.link)),false);
 invite=members.invite();now=invite.expires;assert.throws(()=>members.join(token(invite.link),'99','Partner'),/expired/);
 const restarted=new Members(db,()=>config,()=>now);assert.equal(restarted.authorized('99'),false);assert.equal(restarted.authorized('42'),true);
 assert.equal(canManageMembers({cloudflare:true,identity:{email:'other@example.com'},ownerEmail:'owner@example.com'}),false);
 assert.equal(canManageMembers({cloudflare:true,identity:{email:'owner@example.com'}}),false);
 assert.equal(canManageMembers({cloudflare:true,identity:{email:'Owner@example.com'},ownerEmail:'owner@example.com'}),true);
 }finally{db.close();}
});
test('member confirmation, ownership checks, revoked uploads and notification delivery',async()=>{
 const db=openDatabase(':memory:'),data=mkdtempSync(join(tmpdir(),'members-test-'));const calls=[],changes=[];let imports=0;
 const inbox=new TelegramInbox({db,data,publicOrigin:'https://example.com',updatePurpose:async(id,text)=>changes.push({id,text}),fetcher:async(url,options)=>{calls.push({url,args:JSON.parse(options.body)});return Response.json({ok:true,result:{message_id:100}});},ingest:async()=>{imports++;}});
 inbox.config={bot:'1',owner:'42',username:'fixture_bot',token:'fixture'};
 const id='12345678-1234-1234-1234-123456789abc';db.prepare("INSERT INTO receipts(id,number,created,updated,details) VALUES(?,1,'now','now','{}')").run(id);
 db.prepare("INSERT INTO events(receipt_id,created,type,details) VALUES(?,'now','uploaded',?)").run(id,JSON.stringify({uploadedBy:{id:'99',name:'Partner'}}));
 db.prepare("INSERT INTO telegram_receipts VALUES('1','99',1,?,100,'document')").run(id);
 const msg=(sender,text,extra={})=>({message:{message_id:2,from:{id:sender,first_name:'Partner'},chat:{id:sender,type:'private'},text,...extra}});
 try{
 const token=inbox.members.invite().link.split('join_')[1];await inbox.handle(msg(99,'/start join_'+token));assert.equal(inbox.members.authorized('99'),false);assert.match(calls.at(-1).args.text,/Join/);
 const callback={callback_query:{id:'confirm',from:{id:99,first_name:'Partner'},message:{chat:{id:99,type:'private'}},data:'join:'+token}};await inbox.handle(callback);assert.equal(inbox.members.authorized('99'),true);
 await inbox.handle(msg(99,'my note',{reply_to_message:{message_id:100}}));assert.equal(changes.length,1);
 inbox.members.join(inbox.members.invite().link.split('join_')[1],'88','Other');db.prepare("INSERT INTO telegram_receipts VALUES('1','88',1,?,100,'document')").run(id);
 await inbox.handle(msg(88,'cannot edit duplicate',{reply_to_message:{message_id:100}}));assert.equal(changes.length,1);assert.equal(inbox.canEdit('88',id),false);
 inbox.members.remove('99');const n=calls.length;await inbox.handle(msg(99,'',{document:{file_id:'fixture'}}));await inbox.handle(msg(99,'no',{reply_to_message:{message_id:100}}));assert.equal(imports,0);assert.equal(calls.length,n);
 inbox.members.remove('88');assert.equal(await inbox.notifyRecognition({id,status:'complete'},{id:1}),true);assert.equal(calls.length,n);
 assert.equal(inbox.canEdit('42',id),true);assert.equal(db.prepare('SELECT count(*) n FROM receipts').get().n,1);
 }finally{db.close();rmSync(data,{recursive:true,force:true});}
});
