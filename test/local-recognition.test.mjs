import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseLocalOutput,recognitionIntro} from '../src/local-receipts.mjs';
test('truncated output is never accepted even if its JSON parses',()=>{
  assert.throws(()=>parseLocalOutput({done_reason:'length',message:{content:'{}'}}),e=>e.code==='LOCAL_OUTPUT_LIMIT');
  assert.deepEqual(parseLocalOutput({done_reason:'stop',message:{content:'{"fields":{}}'}}),{fields:{}});
});
test('malformed local output reports a safe error without receipt text',()=>{
  assert.throws(()=>parseLocalOutput({done_reason:'stop',message:{content:'private receipt text'}}),e=>e.code==='LOCAL_INVALID_JSON'&&!e.message.includes('private')&&!e.safeMessage.includes('private'));
});
test('the prompt states the local upload date so recent purchases are not read as future',()=>{
  const local=new Date(2026,9,9,20,30);
  assert.match(recognitionIntro({created:local.toISOString(),purpose:''}),/Upload date: 2026-10-09\./);
  assert.match(recognitionIntro({purpose:''},local),/Upload date: 2026-10-09\./);
});
