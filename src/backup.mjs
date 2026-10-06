// Same-device recovery snapshot. This does not protect against loss of the Mini.
import {constants} from 'node:fs';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdir,mkdtemp,copyFile,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {isEntryPoint} from './cli.mjs';
process.umask(0o077);
export async function verifySnapshot(folder){
  const restore=await mkdtemp(join(tmpdir(),'receiptbox-restore-'));
  try{
    await copyFile(join(folder,'receipts.sqlite'),join(restore,'receipts.sqlite'));
    const db=new DatabaseSync(join(restore,'receipts.sqlite'),{readOnly:true});
    try{
      if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Database verification failed');
      const files=db.prepare('SELECT DISTINCT hash,size FROM files').all();
      for(const f of files){const bytes=await readFile(join(folder,'originals',f.hash));if(bytes.length!==f.size||createHash('sha256').update(bytes).digest('hex')!==f.hash)throw new Error('Original verification failed');}
      return {receipts:db.prepare('SELECT count(*) n FROM receipts').get().n,files:files.length};
    }finally{db.close();}
  }finally{await rm(restore,{recursive:true,force:true});}
}
export async function snapshot(data){
  const destination=join(data,'snapshots');await mkdir(destination,{recursive:true});
  const stage=await mkdtemp(join(destination,'.pending-'));
  try{
    const source=new DatabaseSync(join(data,'receipts.sqlite'),{readOnly:true});
    try{await backup(source,join(stage,'receipts.sqlite'));}finally{source.close();}
    await mkdir(join(stage,'originals'));
    const copy=new DatabaseSync(join(stage,'receipts.sqlite'),{readOnly:true});
    try{for(const f of copy.prepare('SELECT DISTINCT hash FROM files').all())await copyFile(join(data,'originals',f.hash),join(stage,'originals',f.hash),constants.COPYFILE_FICLONE);}finally{copy.close();}
    const counts=await verifySnapshot(stage),created=new Date().toISOString();
    await writeFile(join(stage,'manifest.json'),JSON.stringify({created,...counts,verified:true,sameDevice:true},null,2));
    const folder=join(destination,created.replace(/[:.]/g,'-'));await rename(stage,folder);
    await writeFile(join(data,'snapshot-status.json.tmp'),JSON.stringify({created,...counts,verified:true,sameDevice:true,folder}));
    await rename(join(data,'snapshot-status.json.tmp'),join(data,'snapshot-status.json'));
    return {created,...counts,verified:true,sameDevice:true};
  }catch(error){await rm(stage,{recursive:true,force:true});throw error;}
}
if(isEntryPoint(import.meta.url)){
  try{const data=resolve(process.env.RECEIPTBOX_DATA||'data');console.log(JSON.stringify(await snapshot(data)));}
  catch{console.error('Recovery snapshot failed. Existing originals and previous snapshots are unchanged.');process.exitCode=1;}
}
