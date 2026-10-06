import {readdir,readFile,writeFile,mkdir,copyFile,rename,rm,stat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function verifyRelease(directory) {
  const manifest=JSON.parse(await readFile(join(directory,'release.json'),'utf8'));
  const expected=`v${manifest.version}-${digest(JSON.stringify(manifest.files)).slice(0,16)}`;
  if(manifest.id!==expected)throw new Error('Release manifest identity mismatch.');
  for(const [name,hash] of Object.entries(manifest.files)){
    if(name.startsWith('/')||name.split('/').includes('..'))throw new Error('Invalid release filename.');
    if(digest(await readFile(join(directory,name)))!==hash)throw new Error(`Release file changed: ${name}`);
  }
  return manifest;
}
export async function buildRelease(source,releases) {
  await mkdir(releases,{recursive:true});
  const stage=join(releases,'.stage-'+randomUUID());await mkdir(stage);
  try{
    const exists=path=>stat(path).then(()=>true,()=>false),names=[];
    for(const name of ['package.json','README.md','LICENSE'])if(await exists(join(source,name)))names.push(name);
    // Releases carry runtime code only; tests, docs and deployment templates stay in the repository.
    for(const directory of ['src','public','scripts','native'])if(await exists(join(source,directory)))for(const name of await readdir(join(source,directory)))if(!name.startsWith('.'))names.push(directory+'/'+name);
    for(const binary of ['receipt-image','receipt-preview'])if(await exists(join(source,'bin',binary)))names.push('bin/'+binary);
    const files={};
    for(const name of names.sort()){
      const bytes=await readFile(join(source,name));files[name]=digest(bytes);
      if(name.includes('/'))await mkdir(join(stage,name.split('/')[0]),{recursive:true});
      await copyFile(join(source,name),join(stage,name));
    }
    const version=JSON.parse(await readFile(join(source,'package.json'),'utf8')).version;
    const id=`v${version}-${digest(JSON.stringify(files)).slice(0,16)}`;
    await writeFile(join(stage,'release.json'),JSON.stringify({format:1,id,version,files},null,2));
    const destination=join(releases,id);
    if(await stat(destination).then(()=>true,()=>false)){await verifyRelease(destination);await rm(stage,{recursive:true});}
    else await rename(stage,destination);
    return {id,directory:destination};
  }catch(error){await rm(stage,{recursive:true,force:true});throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const [action,...args]=process.argv.slice(2);
    if(!['build','verify'].includes(action))throw new Error('Usage: node release.mjs build <source> <release-directory> | verify <release>');
    const result=action==='build'?await buildRelease(...args):await verifyRelease(args[0]);
    console.log(JSON.stringify({id:result.id,directory:result.directory,verified:action==='verify'}));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
