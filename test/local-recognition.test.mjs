import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseLocalOutput} from '../src/local-receipts.mjs';
test('truncated output is never accepted even if its JSON parses',()=>{
  assert.throws(()=>parseLocalOutput({done_reason:'length',message:{content:'{}'}}),e=>e.code==='LOCAL_OUTPUT_LIMIT');
  assert.deepEqual(parseLocalOutput({done_reason:'stop',message:{content:'{"fields":{}}'}}),{fields:{}});
});
test('malformed local output reports a safe error without receipt text',()=>{
  assert.throws(()=>parseLocalOutput({done_reason:'stop',message:{content:'private receipt text'}}),e=>e.code==='LOCAL_INVALID_JSON'&&!e.message.includes('private')&&!e.safeMessage.includes('private'));
});
