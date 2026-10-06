import {test} from 'node:test';import assert from 'node:assert/strict';
import {downloadName,exportFiles,receiptCsv,receiptReport,safeName} from '../src/exports.mjs';
const file={id:'file-1',mime:'image/jpeg',hash:'unchanged',size:10};
const receipt={id:'record',reference:'RC-00005',merchant:'Centex',date:'2026-09-27',currency:'CAD',total:'70',tax:'3.33',category:'fuel',status:'complete',purpose:'Client visit',files:[file]};
test('download names describe receipts and distinguish duplicates and multiple pages',()=>{
 assert.equal(downloadName(receipt,file),'2026-09-27 - Centex - CAD 70.00.jpg');
 const many={...receipt,files:[file,{...file,id:'file-2'}]};assert.match(downloadName(many,many.files[1]),/page 2\.jpg$/);
 const files=exportFiles([receipt,{...receipt,id:'another'}]);assert.equal(new Set(files.map(f=>f.name)).size,2);assert.match(files[1].name,/\(2\)\.jpg$/);assert.equal(files[0].hash,'unchanged');
 assert.ok(!files[0].name.includes('RC-'));assert.match(downloadName({...receipt,title:'Client / meeting'},file),/Client - meeting/);
 assert.ok(Buffer.byteLength(safeName('测'.repeat(500)))<=150);assert.ok(!safeName('../../a\\b\n').includes('/'));assert.equal(safeName('CON'),'Receipt CON');
});
test('exports lead with saved details, preserve audit references and escape untrusted content',()=>{
 const r={...receipt,merchant:'<script>evil</script>',purpose:'=FORMULA("x")'},files=exportFiles([r]);
 const csv=receiptCsv([r],files);assert.ok(csv.startsWith('\ufeff"Receipt date","Merchant","Total","Tax","Currency"'));assert.ok(csv.includes("'=FORMULA"));assert.ok(csv.indexOf('Record reference')>csv.indexOf('Notes'));
 const report=receiptReport([r],files,{name:'Company & Co'});assert.ok(report.includes('&lt;script&gt;evil&lt;/script&gt;'));assert.ok(!report.includes('<script>'));assert.ok(report.includes('Company &amp; Co'));assert.ok(report.includes('3.33'));assert.ok(report.includes('RC-00005'));assert.ok(report.includes(files[0].name.split('/').map(encodeURIComponent).join('/')));
});
