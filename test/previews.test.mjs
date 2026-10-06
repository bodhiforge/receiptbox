import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';import {PreviewStore} from '../src/previews.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
function pdf(){const content='BT /F1 18 Tf 20 140 Td (FICTIONAL PREVIEW TEST) Tj ET';const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'];let text='%PDF-1.4\n',offsets=[];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${o}\nendobj\n`;});const xref=Buffer.byteLength(text);return Buffer.from(text+`xref\n0 7\n0000000000 65535 f \n${offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);}
test('preview requests coalesce, cache atomically and leave original bytes intact',async()=>{
 const data=await mkdtemp(join(tmpdir(),'preview-cache-'));await mkdir(join(data,'originals'));const bytes=pdf(),hash=createHash('sha256').update(bytes).digest('hex');await writeFile(join(data,'originals',hash),bytes);let calls=0;
 const store=new PreviewStore({data,root,render:async(file,path)=>{calls++;await writeFile(path,Buffer.from([255,216,255,217]));return {pages:2,width:300,height:180};}}),file={hash,mime:'application/pdf'};
 try{const [a,b]=await Promise.all([store.page(file),store.page(file)]);assert.equal(a.path,b.path);assert.equal(calls,1);await store.page(file);assert.equal(calls,1);await store.page(file,1);assert.equal(calls,2);assert.deepEqual(await readFile(join(data,'originals',hash)),bytes);await assert.rejects(store.page(file,-1),/Invalid/);await assert.rejects(store.page({...file,hash:'../../secret'}),/Invalid/);}finally{await rm(data,{recursive:true,force:true});}
});
const native=await access(join(root,'bin','receipt-preview')).then(()=>true,()=>false);
test('native Mini-compatible renderer previews every PDF page and HEIC without changing either original',{skip:!native},async()=>{
 const data=await mkdtemp(join(tmpdir(),'preview-native-'));await mkdir(join(data,'originals'));const store=new PreviewStore({data,root});
 async function put(bytes,mime){const hash=createHash('sha256').update(bytes).digest('hex');await writeFile(join(data,'originals',hash),bytes);return {hash,mime};}
 try{
  const bytes=pdf(),file=await put(bytes,'application/pdf'),first=await store.page(file),second=await store.page(file,1);
  assert.equal(first.pages,2);assert.equal(second.pages,2);assert.ok(first.width<=3000);assert.deepEqual(await readFile(join(data,'originals',file.hash)),bytes);
  const heic=join(data,'fixture.heic');execFileSync('/usr/bin/sips',['-s','format','heic',first.path,'--out',heic],{stdio:'pipe'});
  const heicBytes=await readFile(heic),heicFile=await put(heicBytes,'image/heic'),preview=await store.page(heicFile);assert.equal(preview.pages,1);assert.deepEqual(await readFile(join(data,'originals',heicFile.hash)),heicBytes);
  await assert.rejects(store.page(file,2),/Preview unavailable/);
 }finally{await rm(data,{recursive:true,force:true});}
});
