import {randomUUID} from 'node:crypto';
import {transaction} from './database.mjs';

export class NotificationDelivery {
  constructor({db,getReceipt,recognition,send,clock=Date.now}) {
    Object.assign(this,{db,getReceipt,recognition,send,clock});
    this.running=false;this.busy=false;
  }
  async tick() {
    if(this.busy)return;
    this.busy=true;
    try {
      const token=randomUUID(),now=this.clock();
      const row=transaction(this.db,()=>{
        this.db.prepare("UPDATE notification_outbox SET status='pending',lease_token=NULL WHERE status='sending' AND lease_until<=?").run(now);
        const next=this.db.prepare("SELECT * FROM notification_outbox WHERE status='pending' AND next_attempt<=? ORDER BY id LIMIT 1").get(now);
        if(!next)return null;
        this.db.prepare("UPDATE notification_outbox SET status='sending',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(token,now+120000,next.id);
        return next;
      });
      if(!row)return;
      const jobRow=this.db.prepare('SELECT * FROM receipt_ai WHERE id=?').get(row.job);
      const job=this.recognition.latest(jobRow.receipt);
      let delivered=false,error=null;
      try {
        delivered=job?.id!==row.job || !['ready','failed'].includes(job.status) || await this.send(this.getReceipt(job.receipt),job);
      } catch { error='Delivery failed; will retry. Receipt data remains saved.'; }
      transaction(this.db,()=>{
        const changed=this.db.prepare("UPDATE notification_outbox SET status=?,error=?,next_attempt=?,lease_token=NULL,lease_until=0,updated=? WHERE id=? AND lease_token=?").run(delivered?'sent':'pending',delivered?null:error||'Waiting for Telegram receipt acknowledgement.',delivered?0:this.clock()+Math.min(3600000,15000*2**Math.min(row.attempts,8)),new Date(this.clock()).toISOString(),row.id,token).changes;
        if(changed&&delivered)this.db.prepare('UPDATE receipt_ai SET notified=1 WHERE id=?').run(row.job);
      });
    } finally { this.busy=false; }
  }
  start() {
    if(this.running)return;this.running=true;
    void (async()=>{while(this.running){try{await this.tick();}catch{console.error('Notification delivery loop failed; durable messages retained.');}await new Promise(r=>{const t=setTimeout(r,1000);t.unref();});}})();
  }
}
