import {mkdir,mkdtemp,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export class PreviewStore {
  constructor({data,root,render}){this.data=data;this.root=root;this.pending=new Map();this.tail=Promise.resolve();this.render=render|| (async(file,destination,page)=>JSON.parse((await exec(join(root,'bin','receipt-preview'),[join(data,'originals',file.hash),file.mime,destination,String(page)],{timeout:45000,maxBuffer:64000})).stdout));}
  async page(file,page=0){
    if(!/^[a-f0-9]{64}$/.test(file.hash)||!Number.isSafeInteger(page)||page<0||page>9999)throw Object.assign(new Error('Invalid preview page.'),{status:400});
    const folder=join(this.data,'previews','v1',file.hash),target=join(folder,`${page}.jpg`),meta=join(folder,`${page}.json`),key=file.hash+':'+page;
    try{const info=JSON.parse(await readFile(meta,'utf8'));await readFile(target);return {...info,path:target};}catch{}
    if(this.pending.has(key))return this.pending.get(key);
    if(this.pending.size>=32)throw Object.assign(new Error('Preview queue is busy. Please retry shortly.'),{status:503});
    const work=this.tail.then(async()=>{
      await mkdir(folder,{recursive:true,mode:0o700});const stage=await mkdtemp(join(folder,'.render-'));
      try{
        const info=await this.render(file,join(stage,'page.jpg'),page);
        if(!Number.isSafeInteger(info.pages)||info.pages<1||page>=info.pages)throw new Error('Invalid preview result.');
        const bytes=await readFile(join(stage,'page.jpg'));if(bytes[0]!==255||bytes[1]!==216)throw new Error('Invalid preview image.');
        await writeFile(join(stage,'page.json'),JSON.stringify(info));
        await rename(join(stage,'page.jpg'),target);await rename(join(stage,'page.json'),meta);return {...info,path:target};
      }catch{throw Object.assign(new Error('Preview unavailable. Your original is safe and can still be downloaded.'),{status:422});}
      finally{await rm(stage,{recursive:true,force:true});}
    });
    this.pending.set(key,work);this.tail=work.catch(()=>{});
    try{return await work;}finally{this.pending.delete(key);}
  }
}
