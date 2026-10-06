import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildRelease,verifyRelease} from '../src/release.mjs';

test('releases have reproducible identities, exclude data and reject changed code',async()=>{
  const root=await mkdtemp(join(tmpdir(),'receiptbox-release-'));
  try{
    const source=join(root,'source'),releases=join(root,'releases');
    await mkdir(join(source,'public'),{recursive:true});await mkdir(join(source,'src'));await mkdir(join(source,'data'));
    await writeFile(join(source,'package.json'),JSON.stringify({version:'0.3.0'}));
    await writeFile(join(source,'src','server.mjs'),'// sample source');
    await writeFile(join(source,'public','index.html'),'<p>Sample</p>');
    await writeFile(join(source,'data','private.json'),'never package this');
    const first=await buildRelease(source,releases),second=await buildRelease(source,releases);
    assert.equal(first.id,second.id);assert.ok(!(await readdir(first.directory)).includes('data'));
    assert.equal((await verifyRelease(first.directory)).id,first.id);
    await writeFile(join(first.directory,'src','server.mjs'),'changed');
    await assert.rejects(()=>verifyRelease(first.directory),/changed/);
  }finally{await rm(root,{recursive:true,force:true});}
});
