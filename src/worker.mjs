import {rememberedCategory} from './categorization.mjs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase} from './database.mjs';
import {RecognitionQueue} from './recognition.mjs';
import {createReceiptService} from './receipts.mjs';
import {localRecognizer} from './local-receipts.mjs';
import {defaultProfile} from './business.mjs';

process.umask(0o077);
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const data=resolve(process.env.RECEIPTBOX_DATA||join(root,'data'));
const db=openDatabase(join(data,'receipts.sqlite'));
let receipts;
const getProfile=()=>JSON.parse(db.prepare('SELECT value FROM company_profile WHERE id=1').get()?.value||JSON.stringify(defaultProfile));
const recognition=new RecognitionQueue({db,getReceipt:id=>receipts.get(id),runModel:localRecognizer({root,data,rememberCategory:(merchant,id)=>rememberedCategory(db,merchant,id)}),enabled:process.env.RECEIPTBOX_LOCAL_AI==='1'});
receipts=createReceiptService({db,data,recognition});
recognition.start();
// Keep the worker alive between jobs; all business work is lease protected.
const keepAlive=setInterval(()=>{},60000);
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{
  recognition.running=false;clearInterval(keepAlive);
  // A interrupted model request must not publish after another worker claims
  // its lease. The next worker recovers it after lease expiration.
  db.close();process.exit(0);
});
