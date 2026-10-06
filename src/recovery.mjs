import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,stat,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {verifySnapshot} from './backup.mjs';
import {isEntryPoint} from './cli.mjs';

const execute=promisify(execFile);
export function recovery(config) {
  if(!config.repository||!config.passwordFile)throw new Error('Explicit repository and password file are required.');
  const passwordFile=resolve(config.passwordFile),binary=config.binary||'/opt/homebrew/bin/restic';
  async function run(args,cwd) {
    const permissions=await stat(passwordFile);
    if(!permissions.isFile()||(permissions.mode&0o077))throw new Error('Backup password file must be private (0600).');
    const env={...process.env};
    for(const key of Object.keys(env))if(key.startsWith('RESTIC_'))delete env[key];
    try{
      const {stdout}=await execute(binary,['--repo',config.repository,'--password-file',passwordFile,...args],{cwd,env,timeout:3600000,maxBuffer:4*1024*1024});
      return stdout;
    }catch{throw new Error('Encrypted backup operation failed. Repository and current receipt data were not replaced.');}
  }
  return {
    init:()=>run(['init']),
    async backup(folder){
      await verifySnapshot(folder);
      const result=await run(['backup','--json','--tag','receiptbox','receipts.sqlite','originals','manifest.json'],resolve(folder));
      const summary=result.trim().split('\n').map(line=>JSON.parse(line)).find(row=>row.message_type==='summary');
      if(!summary?.snapshot_id)throw new Error('Backup did not return a snapshot ID.');
      return {snapshotId:summary.snapshot_id};
    },
    check:()=>run(['check','--read-data']),
    async restore(snapshotId,target){
      if(!/^[a-f0-9]{8,64}$/.test(snapshotId))throw new Error('Use an explicit backup snapshot ID.');
      // Never merge a restore into an existing directory, especially live data.
      await mkdir(target,{mode:0o700});
      await run(['restore',snapshotId,'--target',resolve(target)]);
      return verifySnapshot(target);
    }
  };
}

if(isEntryPoint(import.meta.url)){
  try{
    const [action,configPath,...args]=process.argv.slice(2);
    if(!['init','backup','check','restore'].includes(action)||!configPath)throw new Error('Usage: node recovery.mjs <init|backup|check|restore> <config.json> [snapshot-folder | snapshot-id restore-directory]');
    const helper=recovery(JSON.parse(await readFile(configPath,'utf8')));
    const result=await helper[action](...args);console.log(typeof result==='string'?'Operation completed.':JSON.stringify(result));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
