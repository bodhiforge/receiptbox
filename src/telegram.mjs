import {Members} from './members.mjs';
import {savedMessage,resultMessage,receiptCard} from '../public/feedback.mjs';
import {existsSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {migrate,transaction} from './database.mjs';

export class TelegramInbox {
  constructor({db,data,ingest,updatePurpose,updateDetails,getReceipt,acceptRecognition,completeReceipt,resolveDuplicate,localAI=false,publicOrigin,fetcher=fetch}) {
    Object.assign(this,{db,ingest,updatePurpose,updateDetails,getReceipt,acceptRecognition,completeReceipt,resolveDuplicate,localAI,publicOrigin,fetcher});
    this.path=join(data,'telegram-private.json');
    this.config=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):null;
    this.members=new Members(db,()=>this.config);
    this.lastPoll=null;this.lastError=null;this.running=false;
    migrate(db);
    db.exec(`CREATE TABLE IF NOT EXISTS telegram_offsets(bot TEXT PRIMARY KEY, next_offset INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_receipts(bot TEXT NOT NULL, chat TEXT NOT NULL, message INTEGER NOT NULL,
      receipt TEXT NOT NULL REFERENCES receipts(id), reply INTEGER, transport TEXT NOT NULL,
      PRIMARY KEY(bot,chat,message));
      CREATE TABLE IF NOT EXISTS telegram_followups(bot TEXT,chat TEXT,message INTEGER,receipt TEXT NOT NULL REFERENCES receipts(id),PRIMARY KEY(bot,chat,message));
      CREATE TABLE IF NOT EXISTS telegram_notifications(bot TEXT NOT NULL,job INTEGER NOT NULL,chat TEXT NOT NULL,message INTEGER NOT NULL,receipt TEXT NOT NULL REFERENCES receipts(id),PRIMARY KEY(bot,job));`);
    // Only acknowledgements created by this version are eligible for editing.
    // Kept separate from legacy receipt mappings for rollback compatibility.
    db.exec(`CREATE TABLE IF NOT EXISTS telegram_cards (
      bot TEXT NOT NULL,chat TEXT NOT NULL,message INTEGER NOT NULL,
      receipt TEXT NOT NULL REFERENCES receipts(id),PRIMARY KEY(bot,chat,message));`);
  }
  persist() {
    const temp=this.path+'.tmp';const fd=openSync(temp,'w',0o600);
    try {writeFileSync(fd,JSON.stringify(this.config));fsyncSync(fd);} finally {closeSync(fd);}
    renameSync(temp,this.path);
    const directory=openSync(dirname(this.path),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
  }
  status() {
    return {configured:Boolean(this.config),username:this.config?.username||null,paired:Boolean(this.config?.owner),memberCount:this.members.list().members.length,
      link:this.config?`https://t.me/${this.config.username}${this.config.owner?'':`?start=pair_${this.config.pairing}`}`:null,
      lastPoll:this.lastPoll,error:this.lastError||this.lastNotificationError||null};
  }
  async call(method,args={},token=this.config?.token) {
    let response,payload;
    try {
      response=await this.fetcher(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(35000)});
      payload=await response.json();
    } catch {throw new Error('Telegram is unreachable. Please retry.');}
    if(!response.ok||!payload.ok)throw Object.assign(new Error(`Telegram request failed (${payload.error_code||response.status}). Check the bot token and connection.`),{notModified:payload.description?.includes('message is not modified'),telegramCode:payload.error_code||response.status});
    return payload.result;
  }
  async configure(token) {
    if(this.config)throw Object.assign(new Error('A bot is already connected. Use the pairing link below.'),{status:409});
    if(typeof token!=='string'||!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token.trim()))throw Object.assign(new Error('Enter the token issued by BotFather.'),{status:400});
    token=token.trim();
    const me=await this.call('getMe',{},token);
    if(!me.is_bot||!me.username)throw new Error('This token does not identify a bot.');
    const webhook=await this.call('getWebhookInfo',{},token);
    if(webhook.url)throw Object.assign(new Error('This bot already has a webhook. Create a separate receipt bot; the existing bot was not changed.'),{status:409});
    // No deleteWebhook or negative offset: pending updates are never discarded.
    this.config={token,bot:String(me.id),username:me.username,owner:null,pairing:randomBytes(18).toString('hex')};
    this.persist();return this.status();
  }
  async send(chat,text,replyTo) {
    return this.call('sendMessage',{chat_id:chat,text,...(replyTo?{reply_parameters:{message_id:replyTo,allow_sending_without_reply:true}}:{})});
  }
  async download(media) {
    if(media.file_size>20*1024*1024)throw Object.assign(new Error('This file exceeds 20 MB. Upload it through the review website instead.'),{userError:true});
    const file=await this.call('getFile',{file_id:media.file_id});
    if(!file.file_path||file.file_path.includes('..')||!/^[a-zA-Z0-9_./-]+$/.test(file.file_path))throw new Error('Telegram did not provide a valid file.');
    const response=await this.fetcher(`https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`,{signal:AbortSignal.timeout(35000)});
    if(!response.ok)throw new Error('Could not download the receipt from Telegram.');
    let size=0;const chunks=[];
    for await(const chunk of response.body){size+=chunk.length;if(size>20*1024*1024)throw Object.assign(new Error('This file exceeds 20 MB.'),{userError:true});chunks.push(chunk);}
    return Buffer.concat(chunks);
  }
  async notifyRecognition(receipt,job) {
    if(!this.config?.owner||receipt.deleted_at)return true;
    const row=this.db.prepare('SELECT * FROM telegram_receipts WHERE bot=? AND receipt=? ORDER BY message DESC LIMIT 1').get(this.config.bot,receipt.id);
    if(!row||!this.members.authorized(row.chat))return true;
    if(!row.reply)return false;
    if(this.db.prepare('SELECT 1 FROM telegram_notifications WHERE bot=? AND job=?').get(this.config.bot,job.id))return true;
    const feedback=resultMessage(receipt,job);
    const text=feedback.text;
    const buttons=this.resultButtons(receipt,feedback);
    try{
      const editable=this.db.prepare('SELECT 1 FROM telegram_cards WHERE bot=? AND chat=? AND message=? AND receipt=?').get(this.config.bot,row.chat,row.reply,receipt.id);
      let sent;
      if(editable){
        const edited=await this.editCard(row.chat,row.reply,feedback.silent?text:savedMessage('',{processing:false}),feedback.silent?buttons:[]);
        if(edited&&feedback.silent)sent={message_id:row.reply};
      }
      // Exceptions notify; legacy acknowledgements and unavailable messages use a new reply.
      if(!sent)sent=await this.call('sendMessage',{chat_id:row.chat,text,parse_mode:'HTML',disable_notification:feedback.silent,reply_parameters:{message_id:row.message,allow_sending_without_reply:true},reply_markup:{inline_keyboard:buttons}});
      this.db.exec('BEGIN IMMEDIATE');
      try{
        this.db.prepare('INSERT INTO telegram_notifications VALUES(?,?,?,?,?)').run(this.config.bot,job.id,row.chat,sent.message_id,receipt.id);
        this.db.prepare('INSERT OR IGNORE INTO telegram_followups VALUES(?,?,?,?)').run(this.config.bot,row.chat,sent.message_id,receipt.id);
        this.db.exec('COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
      this.lastNotificationError=null;
    }catch{
      this.lastNotificationError='Recognition is saved on Mini, but Telegram result delivery is retrying.';
      return false;
    }
    return true;
  }
  async editCard(chat,message,text,buttons=[]){
    try{await this.call('editMessageText',{chat_id:chat,message_id:message,text,parse_mode:'HTML',reply_markup:{inline_keyboard:buttons}});return true;}
    catch(error){if(error.notModified)return true;if(error.telegramCode===400)return false;throw error;}
  }
  resultButtons(receipt,feedback){
    const buttons=[[{text:feedback.button,url:`${this.publicOrigin}/#receipt=${receipt.id}`}]];
    if(receipt.duplicatePending)buttons.unshift([{text:'Use existing',callback_data:`dup:e:${receipt.version}:${receipt.id}`},{text:'Keep both',callback_data:`dup:k:${receipt.version}:${receipt.id}`}]);
    if(receipt.possibleDuplicate&&!receipt.duplicatePending)buttons.unshift([{text:'View existing',url:`${this.publicOrigin}/#receipt=${receipt.possibleDuplicate.id}`}]);
    return buttons;
  }
  async sendDetails(chat,id){
    const receipt=this.getReceipt?.(id);if(!receipt)return;
    const feedback=resultMessage(receipt,receipt.ai);
    const reply=await this.call('sendMessage',{chat_id:chat,text:feedback.text,parse_mode:'HTML',reply_markup:{inline_keyboard:this.resultButtons(receipt,feedback)}});
    this.db.prepare('INSERT OR IGNORE INTO telegram_followups VALUES(?,?,?,?)').run(this.config.bot,String(chat),reply.message_id,id);
  }
  canEdit(sender,id){
    if(!this.members.authorized(sender))return false;
    if(String(sender)===this.config.owner)return true;
    const first=this.db.prepare("SELECT details FROM events WHERE receipt_id=? AND type='uploaded' ORDER BY id LIMIT 1").get(id);
    return !!first&&String(JSON.parse(first.details).uploadedBy?.id)===String(sender);
  }
  async handleCallback(query){
    if(query.message?.chat?.type!=='private'||String(query.from?.id)!==String(query.message.chat.id)||query.from?.is_bot)return;
    const join=query.data?.match(/^join:([A-Za-z0-9_-]{32})$/);
    if(join){let text;try{this.members.join(join[1],query.from.id,query.from.first_name);text='You joined. Send a receipt photo or file to save it.';}catch(e){text=e.message;}await this.call('answerCallbackQuery',{callback_query_id:query.id,text,show_alert:true});return;}
    if(!this.members.authorized(query.from?.id))return;
    const duplicate=query.data?.match(/^dup:([ek]):(\d+):([a-f0-9-]{36})$/);
    if(duplicate){const chat=String(query.message.chat.id),id=duplicate[3];
      const mapped=this.db.prepare('SELECT 1 FROM telegram_followups WHERE bot=? AND chat=? AND message=? AND receipt=?').get(this.config.bot,chat,query.message.message_id,id);
      if(!mapped||!this.canEdit(chat,id))return;
      let text,resolved=false;try{this.resolveDuplicate(id,Number(duplicate[2]),duplicate[1]==='k'?'keep':'existing');text=duplicate[1]==='k'?'Both receipts kept. Saved amounts are included in totals.':'Existing receipt kept. This upload moved to Trash; its original is retained.';resolved=true;}catch(e){text=e.status?e.message:'Could not confirm. Open the receipt and try again.';}
      await this.call('answerCallbackQuery',{callback_query_id:query.id,text,show_alert:true});
      if(resolved){
        const receipt=this.getReceipt?.(id);
        const title=duplicate[1]==='k'?'🔁 Kept both':'🔁 Kept the existing receipt';
        try{await this.editCard(chat,query.message.message_id,`<b>${title}</b>\n${receipt?receiptCard(receipt)+'\n':''}${text}`,receipt&&!receipt.deleted_at?[[{text:'Open receipt',url:`${this.publicOrigin}/#receipt=${id}`}]]:[]);}catch{/* The decision is saved; a delivery failure must not repeat it. */}
      }
      return;
    }
    const accept=query.data?.match(/^accept:(\d+):(\d+):([a-f0-9-]{36})$/),complete=query.data?.match(/^complete:(\d+):([a-f0-9-]{36})$/);
    if(!accept&&!complete)return;
    const id=accept?accept[3]:complete[2],chat=String(query.message.chat.id);
    const row=this.db.prepare('SELECT receipt FROM telegram_receipts WHERE bot=? AND chat=? AND reply=? UNION ALL SELECT receipt FROM telegram_followups WHERE bot=? AND chat=? AND message=?').get(this.config.bot,chat,query.message.message_id,this.config.bot,chat,query.message.message_id);
    if(!row||row.receipt!==id||!this.canEdit(chat,id))return;
    let text,success=false;
    try{
      if(accept)this.acceptRecognition(id,Number(accept[1]),Number(accept[2]));
      else await this.completeReceipt(id,Number(complete[1]));
      text=accept?'Recognition fields saved.':'Filed. Original and history kept on Mini.';success=true;
    }catch(error){text=error.status||error.userError?error.message:'This receipt changed. Open it to try again.';}
    await this.call('answerCallbackQuery',{callback_query_id:query.id,text:text.slice(0,190),show_alert:true});
    if(success&&accept)await this.sendDetails(chat,id);
  }
  async handle(update) {
    if(update.callback_query){await this.handleCallback(update.callback_query);return;}
    const message=update.message;if(!message||message.chat?.type!=='private'||!message.from||message.from.is_bot)return;
    const chat=String(message.chat.id),sender=String(message.from.id),text=(message.text||'').trim();
    if(!this.config.owner) {
      if(text!==`/start pair_${this.config.pairing}`)return;
      this.config.owner=sender;this.config.pairing=null;this.persist();
      await this.send(chat,'Receipt Box connected.\nSend a receipt photo or file. Once you see Saved, you can leave.\n\nSend as File to preserve the uploaded file quality.');
      return;
    }
    if(chat!==sender)return;
    const invitation=text.match(/^\/start join_([A-Za-z0-9_-]{32})$/);
    if(invitation&&!this.members.authorized(sender)){
      if(!this.members.valid(invitation[1])){await this.send(chat,'This invitation expired or has already been used. Ask the owner for a new one.');return;}
      const company=JSON.parse(this.db.prepare('SELECT value FROM company_profile WHERE id=1').get()?.value||'{}').name||'the company';
      await this.call('sendMessage',{chat_id:chat,text:`Join ${company}?\nYou can upload receipts and correct your own uploads. Website access is separate.`,reply_markup:{inline_keyboard:[[{text:'Join company',callback_data:`join:${invitation[1]}`}]]}});return;
    }
    if(!this.members.authorized(sender))return;
    if(text.startsWith('/start')||text==='/help') {await this.send(chat,'Send a receipt photo or file.\nSaved means your original is safe. Filed means it is in your totals. Only exceptions need attention.\n\n/review opens your archive and monthly totals.\nTo correct a receipt, reply to its message with e.g. total: 48.40');return;}
    if(text==='/review') {await this.send(chat,`Your receipts and monthly totals (sign in to view):\n${this.publicOrigin}`);return;}
    const media=message.document||message.photo?.at(-1);
    if(media) {
      const prior=this.db.prepare('SELECT * FROM telegram_receipts WHERE bot=? AND chat=? AND message=?').get(this.config.bot,chat,message.message_id);
      if(prior?.reply)return;
      let receiptId=prior?.receipt,result;
      if(!receiptId) {
        try {
          const bytes=await this.download(media);
          if(!this.members.authorized(sender))return;
          result=await this.ingest(bytes,message.document?.file_name||`telegram-photo-${message.message_id}.jpg`,media.mime_type||'image/jpeg',
            {bot:this.config.bot,chat,message:message.message_id,transport:message.document?'document':'photo',sender,senderName:message.from.first_name||'Member'},message.caption?.slice(0,2000)||'');
        } catch(error) {
          if(error.userError||[400,413,415].includes(error.status)){await this.send(chat,'Not saved. Please resend a supported image or PDF, up to 20 MB.');return;}
          throw error;
        }
        receiptId=result.receipt.id;
        this.db.prepare('INSERT OR IGNORE INTO telegram_receipts(bot,chat,message,receipt,transport) VALUES(?,?,?,?,?)').run(this.config.bot,chat,message.message_id,receiptId,message.document?'document':'photo');
      }
      if(message.caption && result && !result.duplicate && !result.receipt.purpose)await this.updatePurpose(receiptId,message.caption.slice(0,2000));
      const row=this.db.prepare('SELECT number FROM receipts WHERE id=?').get(receiptId),reference=`RC-${String(row.number).padStart(5,'0')}`;
      const receipt=result?.receipt||this.getReceipt?.(receiptId);
      const reply=await this.call('sendMessage',{chat_id:chat,text:savedMessage(reference,{duplicate:Boolean(result?.duplicate),processing:this.localAI,receipt}),parse_mode:'HTML',reply_parameters:{message_id:message.message_id,allow_sending_without_reply:true},reply_markup:{inline_keyboard:result?.duplicate||!this.localAI?[[{text:'Open receipt',url:`${this.publicOrigin}/#receipt=${receiptId}`}]]:[]}});
      transaction(this.db,()=>{
        this.db.prepare('UPDATE telegram_receipts SET reply=? WHERE bot=? AND chat=? AND message=?').run(reply.message_id,this.config.bot,chat,message.message_id);
        if(!result?.duplicate)this.db.prepare('INSERT OR IGNORE INTO telegram_cards VALUES(?,?,?,?)').run(this.config.bot,chat,reply.message_id,receiptId);
      });
      return;
    }
    if(text && message.reply_to_message) {
      const id=message.reply_to_message.message_id;
      const row=this.db.prepare('SELECT receipt FROM telegram_receipts WHERE bot=? AND chat=? AND (reply=? OR message=?) UNION ALL SELECT receipt FROM telegram_followups WHERE bot=? AND chat=? AND message=? LIMIT 1').get(this.config.bot,chat,id,id,this.config.bot,chat,id);
      if(row&&this.canEdit(sender,row.receipt)){
        const names={'用途':'purpose','purpose':'purpose','参与人':'people','people':'people','车辆':'vehicle','vehicle':'vehicle','付款人':'payer','payer':'payer','项目':'project','project':'project','报销':'reimbursement','reimbursement':'reimbursement','商家':'merchant','merchant':'merchant','日期':'date','date':'date','总额':'total','total':'total','税额':'tax','tax':'tax','币种':'currency','currency':'currency','分类':'category','category':'category','小费':'tip','tip':'tip','gst':'gst','hst':'hst','pst':'pst','qst':'qst'};
        const details={};let structured=false;const unmatched=[];
        for(const line of text.split('\n')){const part=line.match(/^([^:：]+)[:：]\s*(.*)$/);if(part&&names[part[1].trim().toLowerCase()]){structured=true;details[names[part[1].trim().toLowerCase()]]=part[2].trim();}else if(line.trim())unmatched.push(line);}
        if(structured&&unmatched.length){await this.send(chat,'Nothing changed. Use one field per line, e.g. total: 48.40 or date: 2026-10-03. You can also edit on the receipt page.');return;}
        if(details.category)details.category=({'餐费':'meals','加油':'fuel','油费':'fuel','其他':'other'})[details.category]||details.category;
        try{if(structured&&this.updateDetails)await this.updateDetails(row.receipt,details);else await this.updatePurpose(row.receipt,text.slice(0,2000));}
        catch(error){if(error.userError||error.status){await this.send(chat,'Nothing changed. Use YYYY-MM-DD for dates and numbers for amounts, or edit on the receipt page.');return;}throw error;}
        if(this.getReceipt)await this.sendDetails(chat,row.receipt);else await this.send(chat,'Changes saved on Mini.');return;
      }
    }
    await this.send(chat,'Send a receipt photo or file.\nTo correct a receipt, reply to its message with e.g. total: 48.40.\n/review opens your archive.');
  }
  start() {
    if(this.running||!this.config)return;this.running=true;
    void this.loop();
    void this.processLoop();
  }
  persistUpdates(updates) {
    transaction(this.db,()=>{
      const now=new Date().toISOString();
      for(const update of updates){
        this.db.prepare('INSERT OR IGNORE INTO telegram_updates(bot,id,payload,created,updated) VALUES(?,?,?,?,?)').run(this.config.bot,update.update_id,JSON.stringify(update),now,now);
        this.db.prepare('INSERT INTO telegram_offsets VALUES(?,?) ON CONFLICT(bot) DO UPDATE SET next_offset=max(next_offset,excluded.next_offset)').run(this.config.bot,update.update_id+1);
      }
    });
  }
  async processOne() {
    const row=this.db.prepare("SELECT * FROM telegram_updates WHERE bot=? AND status='pending' AND next_attempt<=? ORDER BY id LIMIT 1").get(this.config.bot,Date.now());
    if(!row)return;
    try {
      await this.handle(JSON.parse(row.payload));
      this.db.prepare("UPDATE telegram_updates SET status='done',error=NULL,updated=? WHERE bot=? AND id=?").run(new Date().toISOString(),row.bot,row.id);
    } catch {
      // Keep failed updates durable and visible. Backoff allows newer receipts
      // to progress instead of one poison update blocking the entire inbox.
      this.db.prepare("UPDATE telegram_updates SET attempts=attempts+1,next_attempt=?,error=?,updated=? WHERE bot=? AND id=?").run(Date.now()+Math.min(3600000,15000*2**Math.min(row.attempts,8)),'Receipt intake is retrying. Keep the source until saved confirmation.',new Date().toISOString(),row.bot,row.id);
    }
  }
  async processLoop() {
    while(this.running){
      try{await this.processOne();}catch{this.lastError='Saved incoming updates are waiting for retry.';}
      await new Promise(resolve=>{const timer=setTimeout(resolve,500);timer.unref();});
    }
  }
  async loop() {
    while(this.running) {
      try {
        const offset=this.db.prepare('SELECT next_offset FROM telegram_offsets WHERE bot=?').get(this.config.bot)?.next_offset||0;
        const updates=await this.call('getUpdates',{offset,timeout:25,allowed_updates:['message','callback_query']});
        if(!this.running)return;
        this.persistUpdates(updates);
        this.lastPoll=new Date().toISOString();this.lastError=null;
      } catch {
        // Never log exceptions containing Bot API URLs (which embed the token).
        this.lastError='Telegram intake is retrying. Keep your receipt until you receive a saved confirmation.';
        await new Promise(resolve=>setTimeout(resolve,10000));
      }
    }
  }
}
