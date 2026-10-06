import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {extractedFields,receiptFingerprint} from '../src/recognition.mjs';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const temporary=await mkdtemp(join(tmpdir(),'receiptbox-test-'));
let child,base;
async function start(overrides={}){
  child=spawn(process.execPath,['src/server.mjs'],{cwd:root,env:{...process.env,PORT:'0',RECEIPTBOX_DATA:join(temporary,'data'),RECEIPTBOX_LOCAL_AI:'',RECEIPTBOX_PUBLIC_ORIGIN:'',RECEIPTBOX_ALLOWED_LOGIN:'',...overrides},stdio:['ignore','pipe','pipe']});
  base=await new Promise((resolve,reject)=>{
    let output='';
    const timeout=setTimeout(()=>reject(new Error('Server startup timed out')),10000);
    child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timeout);resolve(match[0]);}});
    child.on('exit',code=>{clearTimeout(timeout);reject(new Error(`Server exited: ${code}`));});
  });
}
async function stop(){if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}}
after(async()=>{await stop();await rm(temporary,{recursive:true,force:true});});
async function request(path,options={}){const response=await fetch(base+path,{...options,headers:{'X-Receiptbox':'1',...options.headers}});return {status:response.status,body:await response.json()};}
const pdf=Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
async function upload(bytes=pdf,path='/api/receipts',name='receipt.pdf',title=''){
  const form=new FormData();form.append('file',new Blob([bytes],{type:'application/pdf'}),name);if(title)form.append('title',title);return request(path,{method:'POST',body:form});
}
await start();
test('receipt lifecycle, originals, exports and durable state',async t=>{
  let receipt;
  await t.test('shared filing policy is served as a browser module',async()=>{
    const response=await fetch(base+'/receipt-policy.mjs');assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);assert.match(await response.text(),/filingFields/);
  });
  await t.test('empty store and honest file save',async()=>{
    assert.deepEqual((await request('/api/receipts')).body.items,[]);
    const result=await upload(pdf,'/api/receipts','receipt.pdf','Initial sample');assert.equal(result.status,201);receipt=result.body.receipt;
    assert.equal(receipt.status,'review');assert.equal(receipt.title,'Initial sample');assert.equal(receipt.displayName,'Initial sample');assert.equal(receipt.files[0].name,'receipt.pdf');assert.equal(receipt.merchant,'');assert.equal(receipt.events.length,1);
    const original=await fetch(base+'/files/'+receipt.files[0].id);
    assert.match(original.headers.get('content-security-policy'),/frame-ancestors 'self'/);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()),pdf);
    assert.deepEqual(await readFile(join(temporary,'data','originals',receipt.files[0].hash)),pdf);
  });
  await t.test('duplicate upload has no duplicate record or fabricated event',async()=>{
    const result=await upload();assert.equal(result.status,200);assert.equal(result.body.duplicate,true);assert.equal(result.body.receipt.id,receipt.id);
    assert.equal((await request('/api/receipts')).body.items.length,1);assert.equal(result.body.receipt.events.length,1);
  });
  await t.test('reject spoofed file type, empty file, cross-origin and foreign host',async()=>{
    assert.equal((await upload(Buffer.from('<script>alert(1)</script>'))).status,415);
    assert.equal((await upload(Buffer.alloc(0))).status,400);
    assert.equal((await request('/api/receipts',{method:'POST',headers:{Origin:'https://elsewhere.example'}})).status,403);
    assert.equal((await fetch(base+'/api/receipts',{method:'POST'})).status,403);
    const hostStatus=await new Promise((resolve,reject)=>{const req=http.get(base+'/api/receipts',{headers:{Host:'elsewhere.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
    assert.equal(hostStatus,403);
  });
  await t.test('validate completion, store details and optimistic concurrency',async()=>{
    const patch=input=>request('/api/receipts/'+receipt.id,{method:'PATCH',body:JSON.stringify(input)});
    assert.equal((await patch({...receipt,status:'complete'})).status,400);
    assert.equal((await patch({...receipt,date:'2026-02-30'})).status,400);
    assert.equal((await patch({...receipt,total:'-4'})).status,400);
    assert.equal((await patch({...receipt,total:'4',tax:'5'})).status,400);
    const input={...receipt,title:'Client lunch / Alex',merchant:'=SAMPLE merchant',currency:'CAD',date:'2026-10-02',total:'68.50',tax:'3.20',category:'meals',payer:'Company card',purpose:'Project discussion',people:'Alex, client',status:'complete'};
    const result=await patch(input);assert.equal(result.status,200);receipt=result.body;
    assert.equal(receipt.events[0].details.title.to,'Client lunch / Alex');assert.equal(receipt.displayName,'Client lunch / Alex');assert.equal(receipt.events[0].details.total.to,'68.50');assert.equal(receipt.version,2);
    assert.equal((await patch(input)).status,409);
  });
  await t.test('accept recognition requires current version and files, retains human values and audit evidence',async()=>{
    const db=new DatabaseSync(join(temporary,'data','receipts.sqlite'));
    const extracted=Object.fromEntries(extractedFields.map(k=>[k,{value:'',confidence:'low',evidence:''}]));
    extracted.merchant={value:'AI must not overwrite human merchant',confidence:'high',evidence:'fixture'};
    extracted.tip={value:'8.00',confidence:'high',evidence:'Tip 8.00'};
    extracted.gst={value:'3.20',confidence:'low',evidence:'unclear'};
    db.prepare("INSERT INTO receipt_ai(receipt,fingerprint,status,created,updated,result,model) VALUES(?,?,'ready',?,?,?,'local/fixture')").run(receipt.id,receiptFingerprint(receipt),receipt.created,receipt.created,JSON.stringify({documentKind:'receipt',fields:extracted,warnings:[]}));
    const job=Number(db.prepare('SELECT max(id) n FROM receipt_ai').get().n);
    const accept=version=>request(`/api/receipts/${receipt.id}/recognition`,{method:'POST',body:JSON.stringify({action:'accept',job,version})});
    assert.equal((await accept(0)).status,409);
    const accepted=await accept(receipt.version);assert.equal(accepted.status,200);receipt=accepted.body;
    assert.equal(receipt.title,'Client lunch / Alex');assert.equal(receipt.merchant,'=SAMPLE merchant');assert.equal(receipt.tip,'8.00');assert.equal(receipt.gst,'');assert.equal(receipt.status,'review');assert.equal(receipt.events[0].type,'recognition_accepted');
    assert.equal((await accept(receipt.version-1)).status,409);
    db.prepare('UPDATE receipt_ai SET fingerprint=? WHERE id=?').run('stale',job);
    assert.equal((await accept(receipt.version)).status,409);db.close();
  });
  await t.test('attach a page to same receipt and reopen review',async()=>{
    const result=await upload(Buffer.concat([pdf,Buffer.from('\npage two')]),`/api/receipts/${receipt.id}/files`);
    assert.equal(result.status,201);receipt=result.body.receipt;
    assert.equal(receipt.files.length,2);assert.equal(receipt.status,'review');assert.equal(receipt.version,4);
  });
  await t.test('portable CSV and ZIP contain exact originals, history and undated entries',async()=>{
    await upload(Buffer.concat([pdf,Buffer.from('\nundated')]),'/api/receipts','undated.pdf');
    const csv=await(await fetch(base+'/api/export.csv')).text();
    assert.ok(csv.includes("'=SAMPLE merchant"));assert.ok(csv.includes('Project discussion'));
    const archive=Buffer.from(await(await fetch(base+'/api/export.zip')).arrayBuffer());
    const archivePath=join(temporary,'archive.zip');await writeFile(archivePath,archive);
    execFileSync('/usr/bin/unzip',['-t',archivePath]);
    const manifest=JSON.parse(execFileSync('/usr/bin/unzip',['-p',archivePath,'manifest.json']).toString());
    assert.equal(manifest.receipts.length,2);
    const original=execFileSync('/usr/bin/unzip',['-p',archivePath,manifest.files.find(f=>f.fileId===receipt.files[0].id).name]);
    assert.deepEqual(original,pdf);
    assert.equal(manifest.receipts.find(r=>r.id===receipt.id).events.length,4);
    const filtered=await(await fetch(base+'/api/export.csv?from=2020-01-01&to=2020-12-31')).text();
    assert.ok(!filtered.includes('SAMPLE merchant'));assert.ok(filtered.includes('RC-00002'));
    assert.equal((await request('/api/export.csv?from=2026-12-31&to=2026-01-01')).status,400);
  });
  await t.test('trash is recoverable and excluded from normal exports',async()=>{
    const before=(await request('/api/receipts/'+receipt.id)).body;const activeCount=(await request('/api/receipts')).body.total;
    const action=(verb,version)=>request('/api/receipts/'+receipt.id+'/'+verb,{method:'POST',body:JSON.stringify({version})});
    const removed=await action('trash',before.version);assert.equal(removed.status,200);
    assert.equal((await request('/api/receipts')).body.total,activeCount-1);assert.equal((await request('/api/receipts?status=trash')).body.total,1);
    assert.ok(!(await (await fetch(base+'/api/export.csv')).text()).includes(before.reference));
    assert.equal((await action('restore',before.version)).status,409);
    const restored=await action('restore',removed.body.version);assert.equal(restored.status,200);
    assert.equal((await request('/api/receipts')).body.total,activeCount);assert.equal(restored.body.files[0].hash,before.files[0].hash);
    receipt=restored.body;
  });
  await t.test('health counts finished recognition only for active receipts and every unfinished job',async()=>{
    const db=new DatabaseSync(join(temporary,'data','receipts.sqlite'));
    const insert=db.prepare('INSERT INTO receipt_ai(receipt,fingerprint,status,created,updated) VALUES(?,?,?,?,?)');
    for(const status of ['failed','queued'])insert.run(receipt.id,'health-'+status,status,receipt.created,receipt.created);
    const queue=async()=>Object.fromEntries((await request('/api/health')).body.recognition.queue.map(row=>[row.status,row.count]));
    const action=(verb,version)=>request('/api/receipts/'+receipt.id+'/'+verb,{method:'POST',body:JSON.stringify({version})});
    assert.deepEqual(await queue(),{failed:1,queued:1,ready:1});
    const removed=await action('trash',receipt.version);assert.equal(removed.status,200);
    assert.deepEqual(await queue(),{queued:1});
    const restored=await action('restore',removed.body.version);assert.equal(restored.status,200);receipt=restored.body;
    assert.deepEqual(await queue(),{failed:1,queued:1,ready:1});
    db.prepare("DELETE FROM receipt_ai WHERE fingerprint LIKE 'health-%'").run();db.close();
  });
  await t.test('project API and project-specific exports include only assigned receipts',async()=>{
    const created=await request('/api/projects',{method:'POST',body:JSON.stringify({name:'Trip export fixture'})});assert.equal(created.status,200);
    const current=(await request('/api/receipts/'+receipt.id)).body;
    const reserved=await request('/api/receipts/'+receipt.id,{method:'PATCH',body:JSON.stringify({...current,project:'default'})});assert.equal(reserved.status,400);assert.match(reserved.body.error,/reserved/);
    assert.equal((await request('/api/projects',{method:'POST',body:JSON.stringify({name:'Default'})})).status,400);
    receipt=(await request('/api/receipts/'+receipt.id,{method:'PATCH',body:JSON.stringify({...current,project:'Trip export fixture'})})).body;
    const filtered=await(await fetch(base+'/api/export.csv?project=Trip%20export%20fixture')).text();assert.ok(filtered.includes(receipt.reference));assert.ok(!filtered.includes('RC-00002'));
    assert.equal((await request('/api/projects',{method:'PATCH',body:JSON.stringify({from:'Trip export fixture',name:'Renamed trip'})})).status,200);
    receipt=(await request('/api/receipts/'+receipt.id)).body;assert.equal(receipt.project,'Renamed trip');
    assert.equal((await request('/api/projects',{method:'DELETE',body:JSON.stringify({name:'Renamed trip'})})).status,409);
  });
  await t.test('records and originals survive server restart',async()=>{
    await stop();await start();
    const records=(await request('/api/receipts')).body.items;
    assert.equal(records.length,2);assert.equal(records.find(r=>r.id===receipt.id).purpose,'Project discussion');
    const original=await fetch(base+'/files/'+receipt.files[0].id);assert.deepEqual(Buffer.from(await original.arrayBuffer()),pdf);assert.ok(decodeURIComponent(original.headers.get('content-disposition')).includes('Client lunch - Alex'));
  });
  await t.test('remote mode requires the configured identity and HTTPS origin',async()=>{
    await stop();await start({RECEIPTBOX_PUBLIC_ORIGIN:'https://receipt-test.example:8443',RECEIPTBOX_ALLOWED_LOGIN:'test-owner@example.com',RECEIPTBOX_LOCATION:'Mini 4'});
    assert.equal((await request('/api/receipts')).status,403);
    assert.equal((await request('/api/files/'+receipt.files[0].id+'/preview')).status,403);
    assert.equal((await fetch(base+'/api/files/'+receipt.files[0].id+'/preview/0.jpg')).status,403);
    assert.equal((await request('/api/receipts',{headers:{'Tailscale-User-Login':'other@example.com'}})).status,403);
    const headers={'Tailscale-User-Login':'test-owner@example.com'};
    assert.equal((await request('/api/receipts',{headers})).status,200);
    assert.equal((await request('/api/config',{headers})).body.location,'Mini 4');
    assert.equal((await request('/api/receipts',{method:'POST',headers:{...headers,Origin:'https://evil.example'}})).status,403);
    const form=new FormData();form.append('file',new Blob([pdf],{type:'application/pdf'}),'receipt.pdf');
    const upload=await request('/api/receipts',{method:'POST',headers:{...headers,Origin:'https://receipt-test.example:8443'},body:form});
    assert.equal(upload.status,200);assert.equal(upload.body.duplicate,true);
  });
  await t.test('public listener rejects Tailscale spoofing while isolated fallback remains usable',async()=>{
    const listener=http.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
    await stop();await start({RECEIPTBOX_PUBLIC_ORIGIN:'https://receipts.example.com',RECEIPTBOX_ALLOWED_LOGIN:'owner',RECEIPTBOX_TAILSCALE_ORIGIN:'https://private.example:8443',RECEIPTBOX_TAILSCALE_PORT:String(port),RECEIPTBOX_ACCESS_ISSUER:'https://fixture.cloudflareaccess.com',RECEIPTBOX_ACCESS_AUDIENCE:'fixture'});
    for(const path of ['/','/api/receipts','/files/'+receipt.files[0].id,'/api/export.csv'])assert.equal((await fetch(base+path,{headers:{'Tailscale-User-Login':'owner'}})).status,403);
    assert.equal((await fetch(base+'/api/health',{headers:{'Cf-Access-Jwt-Assertion':'invalid'}})).status,403);
    const fallback='http://127.0.0.1:'+port,headers={'Tailscale-User-Login':'owner','X-Receiptbox':'1'};
    assert.equal((await fetch(fallback+'/api/health')).status,403);
    assert.equal((await fetch(fallback+'/api/health',{headers})).status,200);
    assert.equal((await fetch(fallback+'/api/receipts',{method:'POST',headers:{...headers,Origin:'https://receipts.example.com'}})).status,403);
    const current=await fetch(fallback+'/api/receipts/'+receipt.id,{headers}).then(r=>r.json());
    assert.equal((await fetch(fallback+'/api/receipts/'+receipt.id,{method:'PATCH',headers:{...headers,Origin:'https://private.example:8443'},body:JSON.stringify(current)})).status,200);
  });

});
