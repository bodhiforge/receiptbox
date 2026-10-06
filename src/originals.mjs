import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,open,rename,unlink,stat} from 'node:fs/promises';
import {join} from 'node:path';

async function syncDirectory(path) {
  const fd = await open(path,'r');
  try { await fd.sync(); } finally { await fd.close(); }
}

export class OriginalStore {
  constructor(data,{checkpoint=async()=>{}}={}) {
    this.directory=join(data,'originals');
    this.quarantine=join(data,'quarantine');
    this.checkpoint=checkpoint;
    this.pending=new Map();
  }
  path(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid original hash.');
    return join(this.directory,hash);
  }
  async verify(hash,size) {
    const path=this.path(hash);
    try {
      if ((await stat(path)).size!==size) return false;
      const digest=createHash('sha256');
      for await (const chunk of createReadStream(path)) digest.update(chunk);
      return digest.digest('hex')===hash;
    } catch (error) { if (error.code==='ENOENT') return false; throw error; }
  }
  async put(bytes) {
    const hash=createHash('sha256').update(bytes).digest('hex');
    const previous=this.pending.get(hash)||Promise.resolve();
    const operation=previous.catch(()=>{}).then(()=>this.publish(bytes,hash));
    this.pending.set(hash,operation);
    try{return await operation;}finally{if(this.pending.get(hash)===operation)this.pending.delete(hash);}
  }
  async publish(bytes,hash) {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    if (await this.verify(hash,bytes.length)) return hash;
    const temp=join(this.directory,`.pending-${randomUUID()}`);
    const file=await open(temp,'wx',0o600);
    try {
      await file.writeFile(bytes);
      await this.checkpoint('written');
      await file.sync();
    } finally { await file.close(); }
    try {
      await this.checkpoint('synced');
      // Preserve any pre-existing damaged evidence before replacing it with
      // the complete upload whose hash is independently known.
      if (!await this.verify(hash,bytes.length)) {
        await mkdir(this.quarantine,{recursive:true,mode:0o700});
        try {
          await rename(this.path(hash),join(this.quarantine,`${hash}-${randomUUID()}`));
          await syncDirectory(this.quarantine);
        } catch (error) { if (error.code!=='ENOENT') throw error; }
        await rename(temp,this.path(hash));
        await syncDirectory(this.directory);
      }
      await this.checkpoint('published');
      if (!await this.verify(hash,bytes.length)) throw new Error('Original integrity verification failed.');
      return hash;
    } finally { await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;}); }
  }
}
