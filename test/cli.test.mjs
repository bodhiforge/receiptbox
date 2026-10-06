import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase} from '../src/database.mjs';

const root=dirname(dirname(fileURLToPath(import.meta.url)));

test('snapshot command runs when started through a release symlink',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'receiptbox-cli-'));
  try{
    const data=join(folder,'data');
    await mkdir(data);openDatabase(join(data,'receipts.sqlite')).close();
    await symlink(root,join(folder,'current'));
    const output=execFileSync(process.execPath,[join(folder,'current','src','backup.mjs')],{env:{...process.env,RECEIPTBOX_DATA:data}}).toString();
    assert.equal(JSON.parse(output).verified,true);
    assert.equal(JSON.parse(await readFile(join(data,'snapshot-status.json'),'utf8')).verified,true);
  }finally{await rm(folder,{recursive:true,force:true});}
});
