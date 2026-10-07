import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dateCandidates,printedOrder,resolveDate} from '../src/receipt-date.mjs';

test('printed dates produce every valid reading',()=>{
 assert.deepEqual(dateCandidates('10/07/2026 09:24 AM').values,['2026-10-07','2026-07-10']);
 assert.deepEqual(dateCandidates('10.07.26').values,['2026-10-07','2026-07-10']);
 assert.deepEqual(dateCandidates('25/09/2026').values,['2026-09-25']);
 assert.deepEqual(dateCandidates('07/07/2026').values,['2026-07-07']);
 assert.deepEqual(dateCandidates('2026-10-07 14:02').values,['2026-10-07']);
 assert.deepEqual(dateCandidates('2026/10/07').values,['2026-10-07']);
 assert.deepEqual(dateCandidates('Oct 7, 2026').values,['2026-10-07']);
 assert.deepEqual(dateCandidates('7 October 2026').values,['2026-10-07']);
 assert.deepEqual(dateCandidates('07-OCT-26').values,['2026-10-07']);
 assert.deepEqual(dateCandidates('31/02/2026').values,[]);
 assert.deepEqual(dateCandidates('Table 4 Guests 2').values,[]);
});

test('upload time settles a reading only when the other one is clearly older',()=>{
 // The Mon Paris receipt: printed 10/07/2026, sent at 09:25 on 7 Oct.
 assert.deepEqual(resolveDate({evidence:'10/07/2026 09:24 AM',uploadedAt:'2026-10-07T16:25:56Z'}),{value:'2026-10-07',source:'upload_time',printed:'10/07/2026',candidates:['2026-10-07','2026-07-10']});
 // A later reading is impossible regardless of how late the upload is.
 assert.equal(resolveDate({evidence:'03/11/2026',uploadedAt:'2026-04-20T12:00:00Z'}).value,'2026-03-11');
 // Batch upload weeks later: both readings are plausible, so a person chooses.
 const late=resolveDate({evidence:'04/03/2026',uploadedAt:'2026-04-20T12:00:00Z'});
 assert.equal(late.value,undefined);assert.deepEqual(late.candidates,['2026-04-03','2026-03-04']);
 // Old receipt uploaded months later: still a choice.
 assert.equal(resolveDate({evidence:'05/06/2026',uploadedAt:'2026-12-01T12:00:00Z'}).value,undefined);
 // Unambiguous text never needs the upload time.
 assert.deepEqual(resolveDate({evidence:'Oct 7, 2026'}),{value:'2026-10-07',source:'printed',printed:'Oct 7, 2026'});
});

test('another printed date reveals the day/month order',()=>{
 assert.equal(printedOrder(['Card 15/09/2026 10:02']),'dmy');
 assert.equal(printedOrder(['Return by 09/15/2026']),'mdy');
 assert.equal(printedOrder(['15/09/2026','09/15/2026']),null);
 const r=resolveDate({evidence:'04/03/2026',uploadedAt:'2026-04-20T12:00:00Z',lines:['Return by 04/18/2026']});
 assert.deepEqual([r.value,r.source],['2026-04-03','printed_order']);
});
