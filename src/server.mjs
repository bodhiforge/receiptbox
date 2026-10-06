import {canManageMembers} from './members.mjs';
import http from 'node:http';
import {createProjects} from './projects.mjs';
import {downloadName,exportFiles,receiptCsv as csv,receiptReport,safeName} from './exports.mjs';
import {createAccessVerifier,authenticateRequest} from './access.mjs';
import {PreviewStore} from './previews.mjs';
import {openDatabase} from './database.mjs';
import {createReceiptService} from './receipts.mjs';
import {createQueries} from './queries.mjs';
import {NotificationDelivery} from './notifications.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {receiptName} from '../public/receipts.mjs';
import { zip } from './zip.mjs';
import { TelegramInbox } from './telegram.mjs';
import {defaultProfile, validateProfile, summarise, missingFields} from './business.mjs';
import {RecognitionQueue} from './recognition.mjs';

process.umask(0o077);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const data = resolve(process.env.RECEIPTBOX_DATA || join(root, 'data'));
const publicOrigin = process.env.RECEIPTBOX_PUBLIC_ORIGIN || '';
const allowedLogin = process.env.RECEIPTBOX_ALLOWED_LOGIN || '';
if (Boolean(publicOrigin) !== Boolean(allowedLogin)) throw new Error('Private remote access requires both RECEIPTBOX_PUBLIC_ORIGIN and RECEIPTBOX_ALLOWED_LOGIN.');
if (publicOrigin && (new URL(publicOrigin).protocol !== 'https:' || new URL(publicOrigin).origin !== publicOrigin)) throw new Error('RECEIPTBOX_PUBLIC_ORIGIN must be an exact HTTPS origin.');
const accessIssuer=process.env.RECEIPTBOX_ACCESS_ISSUER||'';
const accessAudience=process.env.RECEIPTBOX_ACCESS_AUDIENCE||'';
const tailscaleOrigin=process.env.RECEIPTBOX_TAILSCALE_ORIGIN||'';
const tailscalePort=Number(process.env.RECEIPTBOX_TAILSCALE_PORT||4319);
const accessEnabled=Boolean(accessIssuer||accessAudience);
if(accessEnabled&&(!publicOrigin||!allowedLogin||!tailscaleOrigin||new URL(tailscaleOrigin).protocol!=='https:'||new URL(tailscaleOrigin).origin!==tailscaleOrigin||!Number.isInteger(tailscalePort)||tailscalePort<1||tailscalePort>65535||tailscalePort===Number(process.env.PORT||4317)))throw new Error('Cloudflare requires distinct authenticated Cloudflare and Tailscale listeners.');
const verifyAccess=accessEnabled?createAccessVerifier({issuer:accessIssuer,audience:accessAudience}):null;
const snapshotStatus=()=>{try{return JSON.parse(readFileSync(join(data,'snapshot-status.json'),'utf8'));}catch{return null;}};
const locationLabel = process.env.RECEIPTBOX_LOCATION || 'this Mac';
mkdirSync(join(data, 'originals'), {recursive: true});
const db = openDatabase(join(data,'receipts.sqlite'));
const queries=createQueries(db);
const previews=new PreviewStore({data,root});
const getProfile=()=>JSON.parse(db.prepare('SELECT value FROM company_profile WHERE id=1').get()?.value||JSON.stringify(defaultProfile));
let recognition, receipts;
const aiEnabled=process.env.RECEIPTBOX_LOCAL_AI==='1';
const errors=(status,message)=>Object.assign(new Error(message),{status});
const utc=()=>new Date().toISOString();
const get=id=>receipts.get(id);
const acceptRecognition=(...args)=>receipts.acceptRecognition(...args);
async function body(req, max) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if(length>max) throw errors(413, 'This upload is too large. Each file must be 20 MB or smaller.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function selection(url) {
  const from=url.searchParams.get('from')||'', to=url.searchParams.get('to')||'';
  for(const value of [from,to]) if(value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw errors(400,'Invalid export dates.');
  if(from && to && from>to) throw errors(400,'The start date must precede the end date.');
  // Undated receipts are deliberately included so they cannot silently disappear.
  return db.prepare('SELECT id FROM receipts WHERE deleted_at IS NULL ORDER BY number DESC').all().map(r=>get(r.id)).filter(r=>(!url.searchParams.get('project')||r.project===url.searchParams.get('project'))&&(!r.date || ((!from || r.date>=from) && (!to || r.date<=to))));
}
const staticFiles = {'/receipt-policy.mjs':['receipt-policy.mjs','text/javascript'],'/reporting.mjs':['reporting.mjs','text/javascript'],'/categories.mjs':['categories.mjs','text/javascript'],'/minimal.css':['minimal.css','text/css'],'/feedback.mjs':['feedback.mjs','text/javascript'],'/receipts.mjs':['receipts.mjs','text/javascript'],'/dashboard.mjs':['dashboard.mjs','text/javascript'], '/':['index.html','text/html; charset=utf-8'], '/app.js':['app.js','text/javascript'], '/style.css':['style.css','text/css'], '/logo-192.png':['logo-192.png','image/png'],'/plex-sans-var-latin.woff2':['plex-sans-var-latin.woff2','font/woff2'],'/plex-mono-400-latin.woff2':['plex-mono-400-latin.woff2','font/woff2'],'/plex-mono-500-latin.woff2':['plex-mono-500-latin.woff2','font/woff2'],'/apple-touch-icon.png':['apple-touch-icon.png','image/png']};
const handleRequest = cloudflare => async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; frame-src 'self' blob:; object-src 'none'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  const json = (status,payload)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(payload));};
  try {
    const origin=accessEnabled&&!cloudflare?tailscaleOrigin:publicOrigin;
    const port=req.socket.localPort;
    const allowedHosts=[`127.0.0.1:${port}`,`localhost:${port}`,...(origin?[new URL(origin).host]:[])];
    if(!allowedHosts.includes(req.headers.host))throw errors(403,'Unrecognised application address.');
    const identity=await authenticateRequest(req,{cloudflare,verifyAccess,allowedLogin});
    const url=new URL(req.url,`http://${req.headers.host}`);
    const expectedOrigin=origin||url.origin;
    if(!['GET','HEAD'].includes(req.method) && (req.headers['x-receiptbox']!=='1' || (req.headers.origin && req.headers.origin!==expectedOrigin))) throw errors(403,'Invalid request origin.');
    if(req.method==='GET' && url.pathname==='/api/health') {
      // Trash does not cancel recognition, so unfinished jobs stay visible for the deployment drain check; finished outcomes count only for active receipts.
      const worker=db.prepare("SELECT updated,details FROM worker_health WHERE name='recognition'").get();
      const running=db.prepare("SELECT count(*) n FROM receipt_ai WHERE status='running' AND lease_until>?").get(Date.now()).n;
      return json(200,{schemaVersion:db.prepare('PRAGMA user_version').get().user_version,recognition:{enabled:aiEnabled,alive:!aiEnabled||Boolean(running)||Boolean(worker&&Date.now()-worker.updated<30000),lastHeartbeat:worker?.updated||null,queue:db.prepare("SELECT a.status,count(*) count FROM receipt_ai a JOIN receipts r ON r.id=a.receipt WHERE r.deleted_at IS NULL OR a.status IN ('queued','running') GROUP BY a.status").all()},notifications:db.prepare('SELECT status,count(*) count FROM notification_outbox GROUP BY status').all(),intake:db.prepare("SELECT count(*) pending,coalesce(sum(attempts>0),0) retrying FROM telegram_updates WHERE status='pending'").get(),backupConnected:false});
    }
    if(req.method==='GET' && url.pathname==='/api/config') return json(200,{location:locationLabel,privateRemote:Boolean(publicOrigin),backupConnected:false,localAI:aiEnabled,snapshot:snapshotStatus()});
    if(url.pathname==='/api/projects'){
      const projects=createProjects(db);
      if(req.method==='GET')return json(200,{items:projects.list()});
      if(['POST','PATCH','DELETE'].includes(req.method)){
        const input=JSON.parse((await body(req,4096)).toString());
        return json(200,{items:req.method==='POST'?projects.create(input.name):req.method==='PATCH'?projects.rename(input.from,input.name):projects.remove(input.name)});
      }
    }
    if(req.method==='GET' && url.pathname==='/api/company')return json(200,getProfile());
    if(req.method==='PUT' && url.pathname==='/api/company'){
      let profile;try{profile=validateProfile({...JSON.parse((await body(req,32000)).toString()),projects:getProfile().projects});}catch(e){throw errors(400,e.message);}
      db.prepare('INSERT INTO company_profile VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(profile));return json(200,profile);
    }
    if(req.method==='GET' && url.pathname==='/api/summary')return json(200,{groups:summarise(selection(url)),unfinished:selection(url).filter(r=>r.status!=='complete').map(r=>({reference:r.reference,id:r.id,missing:missingFields(r)}))});
    const duplicateMatch=url.pathname.match(/^\/api\/receipts\/([a-f0-9-]{36})\/duplicate$/);
    if(duplicateMatch&&req.method==='POST'){const input=JSON.parse((await body(req,4096)).toString());return json(200,receipts.resolveDuplicate(duplicateMatch[1],input.version,input.choice));}
    const aiMatch=url.pathname.match(/^\/api\/receipts\/([a-f0-9-]{36})\/recognition$/);
    if(aiMatch && req.method==='POST'){
      const receipt=get(aiMatch[1]);
      const input=JSON.parse((await body(req,4096)).toString());
      if(input.action==='retry'){if(!aiEnabled)throw errors(503,'Local recognition is not enabled.');recognition.enqueue(receipt,true);return json(200,get(receipt.id));}
      if(input.action!=='accept')throw errors(400,'Invalid recognition action.');
      return json(200,acceptRecognition(receipt.id,input.job,input.version));
    }
    if(url.pathname==='/api/members'){
      if(!canManageMembers({cloudflare,identity,ownerEmail:process.env.RECEIPTBOX_OWNER_EMAIL}))throw errors(403,'Only the owner can manage Telegram members.');
      if(req.method==='GET')return json(200,inbox.members.list());
      const input=JSON.parse((await body(req,4096)).toString());
      if(req.method==='POST'&&input.action==='invite')return json(200,inbox.members.invite());
      if(req.method==='DELETE'&&input.action==='remove'){inbox.members.remove(input.user);return json(200,inbox.members.list());}
      if(req.method==='DELETE'&&input.action==='revoke'){inbox.members.revoke(input.id);return json(200,inbox.members.list());}
      throw errors(400,'Invalid member action.');
    }
    if(req.method==='GET' && url.pathname==='/api/telegram') return json(200,inbox.status());
    if(req.method==='POST' && url.pathname==='/api/telegram') {
      if(!allowedLogin)throw errors(403,'Bot setup is available only on an authenticated deployment.');
      const input=JSON.parse((await body(req,4096)).toString());
      let status;
      try{status=await inbox.configure(input.token);}catch(error){throw errors(error.status||400,error.message);}
      inbox.start();return json(200,status);
    }
    if(req.method==='GET' && staticFiles[url.pathname]) {
      const [file,mime]=staticFiles[url.pathname]; res.writeHead(200,{'Content-Type':mime}); res.end(readFileSync(join(root,'public',file))); return;
    }
    if(req.method==='GET' && url.pathname==='/api/receipts') return json(200,queries.list(Object.fromEntries(url.searchParams)));
    if(req.method==='GET' && url.pathname==='/api/facets') return json(200,queries.facets());
    if(req.method==='GET' && url.pathname==='/api/dashboard') return json(200,queries.report(Object.fromEntries(url.searchParams)));
    const receiptMatch=url.pathname.match(/^\/api\/receipts\/([a-f0-9-]{36})$/);
    if(receiptMatch && req.method==='GET')return json(200,get(receiptMatch[1]));
    const trashMatch=url.pathname.match(/^\/api\/receipts\/([a-f0-9-]{36})\/(trash|restore)$/);
    if(trashMatch&&req.method==='POST'){const input=JSON.parse((await body(req,1024)).toString());return json(200,receipts.setDeleted(trashMatch[1],input.version,trashMatch[2]==='trash'));}
    const attachmentMatch=url.pathname.match(/^\/api\/receipts\/([a-f0-9-]{36})\/files$/);
    if(req.method==='POST' && (url.pathname==='/api/receipts' || attachmentMatch)) {
      if(attachmentMatch) get(attachmentMatch[1]);
      const bytes=await body(req,21*1024*1024);
      let form;
      try {form=await new Request(url,{method:'POST',headers:{'Content-Type':req.headers['content-type']||''},body:bytes}).formData();} catch {throw errors(400,'Invalid upload.');}
      const file=form.get('file');
      const uploadTitle=form.get('title')||'';if(typeof uploadTitle!=='string'||uploadTitle.length>250)throw errors(400,'Receipt name must be 250 characters or fewer.');
      if(!file || typeof file.arrayBuffer!=='function' || file.size===0) throw errors(400,'Choose a non-empty receipt file.');
      if(file.size>20*1024*1024) throw errors(413,'Each file must be 20 MB or smaller.');
      const result=await receipts.ingest({bytes:Buffer.from(await file.arrayBuffer()),name:file.name,title:uploadTitle,receiptId:attachmentMatch?.[1]});
      return json(result.duplicate?200:201,result);
    }
    if(receiptMatch && req.method==='PATCH') {
      const input=JSON.parse((await body(req,32*1024)).toString());
      return json(200,receipts.update(receiptMatch[1],input));
    }
    const previewMatch=url.pathname.match(/^\/api\/files\/([a-f0-9-]{36})\/preview(?:\/(\d+)\.jpg)?$/);
    if(req.method==='GET'&&previewMatch){
      const file=db.prepare('SELECT * FROM files WHERE id=?').get(previewMatch[1]);
      if(!file)throw errors(404,'File not found.');
      const page=await previews.page(file,Number(previewMatch[2]||0));
      if(previewMatch[2]===undefined)return json(200,{pages:page.pages,width:page.width,height:page.height});
      res.writeHead(200,{'Content-Type':'image/jpeg'});await pipeline(createReadStream(page.path),res);return;
    }
    const fileMatch=url.pathname.match(/^\/files\/([a-f0-9-]{36})$/);
    if(req.method==='GET' && fileMatch) {
      const file=db.prepare('SELECT * FROM files WHERE id=?').get(fileMatch[1]);
      if(!file) throw errors(404,'File not found.');
      res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'self'; object-src 'self'");
      res.writeHead(200,{'Content-Type':file.mime,'Content-Length':file.size,'Content-Disposition':`${url.searchParams.has('download')?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(downloadName(get(file.receipt_id),file))}`});
      await pipeline(createReadStream(join(data,'originals',file.hash)),res);return;
    }
    if(req.method==='GET' && ['/api/export.csv','/api/export.zip'].includes(url.pathname)) {
      const receipts=selection(url),company=getProfile(),fileMap=exportFiles(receipts);
      const from=url.searchParams.get('from'),to=url.searchParams.get('to');
      const period=from&&to?`${from} to ${to}`:from?`Since ${from}`:to?`Through ${to}`:'All dates';
      const archiveName=safeName(`${company.name||'Company'} - ${url.searchParams.get('project')||'Receipts'} - ${period}`);
      if(url.pathname.endsWith('.csv')) {res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(archiveName+'.csv')}`});res.end(csv(receipts,fileMap));return;}
      const manifest=JSON.stringify({schemaVersion:3,company,summary:summarise(receipts),exportedAt:utc(),range:{from:url.searchParams.get('from'),to:url.searchParams.get('to')},undatedReceiptsIncluded:true,files:fileMap,receipts},null,2);
      const files=fileMap.map(f=>({name:f.name,path:join(data,'originals',f.hash),size:f.size}));
      const entries=[{name:'Receipt details.html',text:receiptReport(receipts,fileMap,company)},{name:'receipts.csv',text:csv(receipts,fileMap)},{name:'manifest.json',text:manifest},{name:'summary.json',text:JSON.stringify(summarise(receipts),null,2)},{name:'unfinished.csv',text:csv(receipts.filter(r=>r.status!=='complete'),fileMap)},{name:'README.txt',text:'Company receipts\n\nOpen Receipt details.html for readable receipt details and links to originals. Open receipts.csv in a spreadsheet. Original files are in receipts/, named by receipt date, merchant and amount. Identical names receive a numeric suffix. Original bytes are unchanged. The manifest maps each file to its record, original filename, hash and edit history. Undated and unfinished receipts are included; Trash is excluded. Item-level printed details remain in the originals. No tax deductibility is inferred.\n'},...files];
      if(entries.length>60000 || files.reduce((s,f)=>s+f.size,0)+entries.reduce((s,e)=>s+(e.text?Buffer.byteLength(e.text):0),0)>3.5*1024**3) throw errors(413,'Choose a smaller date range for this export (under 3.5 GB).');
      res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(archiveName+'.zip')}`});
      await pipeline(Readable.from(zip(entries)),res);return;
    }
    throw errors(404,'Not found.');
  } catch(e) {
    if(res.headersSent) {res.destroy(e);return;}
    if(!e.status && !(e instanceof SyntaxError)) console.error(e);
    json(e.status || (e instanceof SyntaxError ? 400 : 500),{error:e.status?e.message:e instanceof SyntaxError?'Invalid request.':'Could not save or load this record. Please retry; do not discard your original.'});
  }
};
const server=http.createServer(handleRequest(accessEnabled));
const tailscaleServer=accessEnabled?http.createServer(handleRequest(false)):null;
if(tailscaleServer)tailscaleServer.listen(tailscalePort,'127.0.0.1');
const inbox=new TelegramInbox({db,data,publicOrigin,getReceipt:get,acceptRecognition,localAI:aiEnabled,
  resolveDuplicate:(id,version,choice)=>receipts.resolveDuplicate(id,version,choice),
  completeReceipt:async(id,version)=>receipts.update(id,{...get(id),version,status:'complete'}),
  ingest:async(bytes,name,mime,source,purpose)=>receipts.ingest({bytes,name,source,purpose}),
  updatePurpose:async(id,purpose)=>receipts.update(id,{...get(id),purpose,autoStatus:true}),
  updateDetails:async(id,details)=>receipts.update(id,{...get(id),...details,autoStatus:true})
});
recognition=new RecognitionQueue({db,getReceipt:get,enabled:aiEnabled});
receipts=createReceiptService({db,data,recognition});
receipts.reconcileJobs();
const delivery=new NotificationDelivery({db,getReceipt:get,recognition,send:(r,j)=>inbox.notifyRecognition(r,j)});
server.listen(Number(process.env.PORT || 4317),'127.0.0.1',()=>{
  console.log(`Receipt Box: ${publicOrigin||`http://127.0.0.1:${server.address().port}`}\nLocal listener: http://127.0.0.1:${server.address().port}\nData: ${data}\nAccess: ${accessEnabled?'Cloudflare Access + separate Tailscale fallback':allowedLogin?'Tailscale identity required':'local preview only'}; automatic backup not connected.`);
  if(allowedLogin)inbox.start();
  delivery.start();
});
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{inbox.running=false;delivery.running=false;tailscaleServer?.close();server.close(()=>{db.close();process.exit(0);});});
