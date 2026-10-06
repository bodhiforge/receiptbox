// Explicit, isolated Mini smoke check using a supplied fictional receipt.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const data=await mkdtemp(join(tmpdir(),'receiptbox-runtime-'));
const env={...process.env,PORT:'0',RECEIPTBOX_DATA:data,RECEIPTBOX_LOCAL_AI:'1',RECEIPTBOX_PUBLIC_ORIGIN:'',RECEIPTBOX_ALLOWED_LOGIN:''};
const children=[];
const source=join(dirname(dirname(fileURLToPath(import.meta.url))),'src');
const start=file=>{const child=spawn(process.execPath,[join(source,file)],{env,stdio:['ignore','pipe','pipe']});children.push(child);return child;};
const stop=async child=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}};
try{
  const server=start('server.mjs');
  const base=await new Promise((resolve,reject)=>{let text='';server.stdout.on('data',b=>{text+=b;const match=text.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});server.on('exit',()=>reject(Error('Test server stopped')));});
  const bytes=await readFile(process.argv[2]);
  const upload=async content=>{const form=new FormData();form.append('file',new Blob([content]),'fictional-runtime.pdf');const r=await fetch(base+'/api/receipts',{method:'POST',headers:{'X-Receiptbox':'1'},body:form});assert.equal(r.status,201);return (await r.json()).receipt;};
  const first=await upload(bytes);assert.equal(first.ai.status,'queued');
  let worker=start('worker.mjs');
  async function waitReady(id){
    for(let seconds=0;seconds<360;seconds+=2){
      const response=await fetch(base+'/api/receipts/'+id);assert.equal(response.status,200);
      const record=await response.json();
      if(record.ai.status==='ready')return record;
      if(record.ai.status==='failed')throw Error('Local extraction failed');
      if(seconds%20===0)console.log(JSON.stringify({waitingSeconds:seconds,status:record.ai.status}));
      await new Promise(r=>setTimeout(r,2000));
    }
    throw Error('Local extraction timed out');
  }
  const ready=await waitReady(first.id);assert.equal(ready.ai.pipeline_version,'receipt-v3');
  await stop(worker);
  const second=await upload(Buffer.concat([bytes,Buffer.from('\n% second fictional receipt')]));
  assert.equal(second.ai.status,'queued');
  assert.equal((await (await fetch(base+'/api/facets')).json()).total,2);
  worker=start('worker.mjs');await waitReady(second.id);
  const original=await fetch(base+'/files/'+ready.files[0].id);assert.deepEqual(Buffer.from(await original.arrayBuffer()),bytes);
  console.log(JSON.stringify({runtimeCheck:'passed',separateWorker:true,restartRecovery:true,webAvailableWithoutWorker:true,originalBytesPreserved:true}));
}finally{
  for(const child of children.reverse())await stop(child);
  await rm(data,{recursive:true,force:true});
}
