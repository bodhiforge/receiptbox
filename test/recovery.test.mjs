import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile,stat} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/database.mjs';
import {createReceiptService} from '../src/receipts.mjs';
import {RecognitionQueue} from '../src/recognition.mjs';
import {snapshot} from '../src/backup.mjs';
import {recovery} from '../src/recovery.mjs';

const binary='/opt/homebrew/bin/restic';
const available=await stat(binary).then(()=>true,()=>false);
test('encrypted restic repository restores a complete verified archive; wrong keys fail',{skip:!available},async()=>{
  const root=await mkdtemp(join(tmpdir(),'receiptbox-encrypted-'));
  try{
    const data=join(root,'data');await mkdir(data);
    const db=openDatabase(join(data,'receipts.sqlite'));
    let service;const queue=new RecognitionQueue({db,enabled:false,getReceipt:id=>service.get(id)});
    service=createReceiptService({db,data,recognition:queue});
    await service.ingest({bytes:Buffer.from('%PDF-1.4\nFictional encrypted restore fixture\n%%EOF'),name:'fictional.pdf'});
    db.close();await snapshot(data);
    const state=JSON.parse(await readFile(join(data,'snapshot-status.json'),'utf8'));
    const passwordFile=join(root,'key');await writeFile(passwordFile,randomBytes(32).toString('hex'),{mode:0o600});
    const config={repository:join(root,'encrypted-repository'),passwordFile,binary};
    const helper=recovery(config);await helper.init();
    const {snapshotId}=await helper.backup(state.folder);await helper.check();
    assert.deepEqual(await helper.restore(snapshotId,join(root,'restored')),{receipts:1,files:1});
    await assert.rejects(()=>helper.restore(snapshotId,data),/exist/i);
    const wrong=join(root,'wrong-key');await writeFile(wrong,randomBytes(32).toString('hex'),{mode:0o600});
    await assert.rejects(()=>recovery({...config,passwordFile:wrong}).check(),/failed/);
  }finally{await rm(root,{recursive:true,force:true});}
});
