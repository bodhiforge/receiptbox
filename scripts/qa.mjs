// Disposable UI verification environment. No user data is loaded or modified.
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'receiptbox-ui-'));
const content='BT /F1 18 Tf 35 370 Td (SAMPLE RECEIPT) Tj 0 -28 Td /F1 11 Tf (UI testing only - not a real transaction) Tj 0 -45 Td (Sample Cafe) Tj 0 -25 Td (2026-10-02) Tj 0 -35 Td (Meal: CAD 60.00) Tj 0 -20 Td (Tax: CAD 3.00) Tj 0 -20 Td (Tip: CAD 7.00) Tj 0 -30 Td /F1 15 Tf (TOTAL: CAD 70.00) Tj ET';
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 330 420] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
let pdf='%PDF-1.4\n',offsets=[0];
objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;});
const xref=Buffer.byteLength(pdf);
pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(join(dir,'sample-receipt.pdf'),pdf);
console.log(`QA fixture: ${join(dir,'sample-receipt.pdf')}`);
process.env.RECEIPTBOX_DATA=join(dir,'data');
process.env.PORT='4318';
await import('../src/server.mjs');
