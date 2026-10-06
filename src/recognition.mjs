import {createHash,randomUUID} from 'node:crypto';
import {migrate,transaction} from './database.mjs';
import {categories,money} from './business.mjs';

export const extractedFields=['merchant','date','currency','category','subtotal','total','tax','gst','hst','pst','qst','tip'];
export const schema={type:'object',additionalProperties:false,required:['fields','warnings','documentKind'],properties:{documentKind:{type:'string',enum:['receipt','invoice','card_slip','other','unreadable']},warnings:{type:'array',items:{type:'string'},maxItems:12},fields:{type:'object',additionalProperties:false,required:extractedFields,properties:Object.fromEntries(extractedFields.map(k=>[k,{type:'object',additionalProperties:false,required:['value','confidence','evidence'],properties:{value:{type:['string','null']},confidence:{type:'string',enum:['high','medium','low']},evidence:{type:'string'}}}]))}}};
export function sanitiseResult(input){
  if(!input||!input.fields||!['receipt','invoice','card_slip','other','unreadable'].includes(input.documentKind))throw new Error('Recognition returned an invalid document.');
  const fields={},warnings=(Array.isArray(input.warnings)?input.warnings:[]).filter(s=>typeof s==='string').slice(0,12).map(s=>s.slice(0,400));
  for(const key of extractedFields){
    const item=input.fields[key];
    if(!item||!['high','medium','low'].includes(item.confidence)||typeof item.evidence!=='string'||(item.value!==null&&typeof item.value!=='string'))throw new Error('Recognition returned invalid fields.');
    const value=(item.value||'').trim();
    if(value.length>250||item.evidence.length>1000)throw new Error('Recognition response is too large.');
    let valid=!value||Boolean(item.evidence.trim());
    if(value&&['subtotal','total','tax','gst','hst','pst','qst','tip'].includes(key))valid=valid&&money(value)!==null;
    if(key==='category')valid=valid&&categories.includes(value);
    if(key==='currency')valid=valid&&['','CAD','USD','EUR','GBP','JPY','TWD'].includes(value);
    if(key==='date'&&value)valid=valid&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
    if(!valid){warnings.push(`Check ${key}: the extracted value failed validation.`);fields[key]={value:'',confidence:'low',evidence:item.evidence.slice(0,400)};}
    else fields[key]={value,confidence:item.confidence,evidence:item.evidence.slice(0,400),...(key==='category'&&['merchant_memory','provider_rule','local_category_retry'].includes(item.source)?{source:item.source,...(typeof item.receiptId==='string'?{receiptId:item.receiptId}:{})}:{})};
  }
  const total=money(fields.total.value),tax=money(fields.tax.value),sub=money(fields.subtotal.value),tip=money(fields.tip.value);
  if(total!==null&&tax!==null&&tax>total){fields.tax.confidence='low';warnings.push('Tax exceeds the receipt total. Verify the figures.');}
  if(total!==null&&sub!==null&&tax!==null&&tip!==null&&Math.abs(total-sub-tax-tip)>2){warnings.push('Subtotal + tax + tip does not match the total. Verify before confirming.');fields.total.confidence='low';}
  const components=['gst','hst','pst','qst'].map(k=>money(fields[k].value));
  if(tax!==null&&components.some(v=>v!==null)&&Math.abs(components.reduce((s,n)=>s+(n||0),0)-tax)>2)warnings.push('Named tax components do not match total tax; verify the breakdown.');
  if(['other','unreadable'].includes(input.documentKind))warnings.push('This image is not a clearly readable expense receipt.');
  return {documentKind:input.documentKind,fields,warnings:[...new Set(warnings)].slice(0,16)};
}
export const receiptFingerprint=receipt=>createHash('sha256').update(receipt.files.map(f=>f.hash).sort().join('|')).digest('hex');
export const pipelineVersion='receipt-v3';
export class RecognitionQueue {
  constructor({db,getReceipt,runModel,enabled=false,clock=Date.now,leaseMs=120000}) {
    Object.assign(this,{db,getReceipt,runModel,enabled,clock,leaseMs});
    this.busy=false;this.running=false;
    migrate(db);
  }
  latest(id){
    const row=this.db.prepare('SELECT * FROM receipt_ai WHERE receipt=? ORDER BY id DESC LIMIT 1').get(id);
    return row?{...row,result:row.result?JSON.parse(row.result):null}:null;
  }
  enqueue(receipt,retry=false){
    if(!this.enabled)return;
    const now=new Date(this.clock()).toISOString(),fingerprint=receiptFingerprint(receipt);
    this.db.prepare("INSERT OR IGNORE INTO receipt_ai(receipt,fingerprint,status,created,updated,pipeline_version) VALUES(?,?,'queued',?,?,?)").run(receipt.id,fingerprint,now,now,pipelineVersion);
    if(retry){
      const row=this.db.prepare("SELECT id FROM receipt_ai WHERE receipt=? AND fingerprint=? AND status='failed'").get(receipt.id,fingerprint);
      if(row){
        this.db.prepare("UPDATE receipt_ai SET status='queued',attempts=0,error=NULL,notified=0,next_attempt=0,lease_token=NULL,lease_until=0,pipeline_version=? WHERE id=?").run(pipelineVersion,row.id);
        this.db.prepare('DELETE FROM notification_outbox WHERE job=?').run(row.id);
        // Each retry is a new delivery generation; old Telegram mappings remain audit evidence.
        this.db.prepare('DELETE FROM telegram_notifications WHERE job=?').run(row.id);
      }
    }
  }
  outbox(id){
    const now=new Date(this.clock()).toISOString();
    this.db.prepare('INSERT OR IGNORE INTO notification_outbox(job,created,updated) VALUES(?,?,?)').run(id,now,now);
  }
  claim(){
    return transaction(this.db,()=>{
      const now=this.clock();
      for(const row of this.db.prepare("SELECT id,attempts FROM receipt_ai WHERE status='running' AND lease_until<=?").all(now)){
        const terminal=row.attempts>=3;
        this.db.prepare("UPDATE receipt_ai SET status=?,lease_token=NULL,lease_until=0,error=?,updated=? WHERE id=?").run(terminal?'failed':'queued','Recognition worker stopped. The original is safe.',new Date(now).toISOString(),row.id);
        if(terminal)this.outbox(row.id);
      }
      const job=this.db.prepare("SELECT * FROM receipt_ai WHERE status='queued' AND next_attempt<=? ORDER BY id LIMIT 1").get(now);
      if(!job)return null;
      const token=randomUUID();
      this.db.prepare("UPDATE receipt_ai SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,updated=? WHERE id=?").run(token,now+this.leaseMs,new Date(now).toISOString(),job.id);
      return {...job,attempts:job.attempts+1,lease_token:token};
    });
  }
  async tick(){
    if(this.busy||!this.enabled)return;
    this.busy=true;let heartbeat;
    try{
      const job=this.claim();if(!job)return;
      const owns=()=>this.db.prepare("SELECT 1 FROM receipt_ai WHERE id=? AND status='running' AND lease_token=? AND lease_until>?").get(job.id,job.lease_token,this.clock());
      heartbeat=setInterval(()=>{
        try{this.db.prepare("UPDATE receipt_ai SET lease_until=? WHERE id=? AND status='running' AND lease_token=? AND lease_until>?").run(this.clock()+this.leaseMs,job.id,job.lease_token,this.clock());}catch{}
      },Math.max(10,Math.floor(this.leaseMs/3)));heartbeat.unref();
      try{
        const receipt=this.getReceipt(job.receipt);
        if(receiptFingerprint(receipt)!==job.fingerprint){
          if(owns())this.db.prepare("UPDATE receipt_ai SET status='superseded',lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?").run(job.id,job.lease_token);
          return;
        }
        const output=await this.runModel(receipt),result=sanitiseResult(output.result);
        // This comes from the local OCR adapter, outside the model JSON.
        if(Array.isArray(output.currencyEvidence))result.localCurrencyEvidence=output.currencyEvidence.filter(v=>typeof v==='string').slice(0,40).map(v=>v.slice(0,400));
        transaction(this.db,()=>{
          if(!owns())return;
          if(receiptFingerprint(this.getReceipt(job.receipt))!==job.fingerprint){
            this.db.prepare("UPDATE receipt_ai SET status='superseded',lease_token=NULL,lease_until=0 WHERE id=?").run(job.id);return;
          }
          this.db.prepare("UPDATE receipt_ai SET status='ready',result=?,model=?,error=NULL,updated=?,lease_token=NULL,lease_until=0 WHERE id=?").run(JSON.stringify(result),output.model,new Date(this.clock()).toISOString(),job.id);
          this.onReady?.(job.receipt);
          this.outbox(job.id);
        });
      }catch(error){
        console.error(JSON.stringify({event:'recognition_failed',job:job.id,attempt:job.attempts,code:error.code|| (error.name==='TimeoutError'?'LOCAL_TIMEOUT':'LOCAL_RESULT_INVALID')}));
        transaction(this.db,()=>{
          if(!owns())return;
          const retry=job.attempts<3&&!error.permanent,now=this.clock();
          this.db.prepare('UPDATE receipt_ai SET status=?,error=?,updated=?,next_attempt=?,lease_token=NULL,lease_until=0 WHERE id=?').run(retry?'queued':'failed',error.safeMessage||'Recognition unavailable. Your original is saved; retry or enter details manually.',new Date(now).toISOString(),retry?now+15000*2**(job.attempts-1):0,job.id);
          if(!retry)this.outbox(job.id);
        });
      }
    }finally{clearInterval(heartbeat);this.busy=false;}
  }
  start(){
    if(this.running||!this.enabled)return;this.running=true;
    const loop=async()=>{while(this.running){try{await this.tick();this.db.prepare('INSERT INTO worker_health VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET updated=excluded.updated,details=excluded.details').run('recognition',this.clock(),JSON.stringify({pipelineVersion}));}catch(error){console.error('Recognition loop failed:',error.message);}await new Promise(r=>{const t=setTimeout(r,1000);t.unref();});}};
    void loop();
  }
}
