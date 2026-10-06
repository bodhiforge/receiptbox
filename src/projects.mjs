import {transaction} from './database.mjs';
import {defaultProfile,money} from './business.mjs';
import {searchText} from '../public/receipts.mjs';
import {requestError} from './receipts.mjs';
export function createProjects(db){
 const profile=()=>JSON.parse(db.prepare('SELECT value FROM company_profile WHERE id=1').get()?.value||JSON.stringify(defaultProfile));
 const rows=()=>db.prepare('SELECT * FROM receipts').all().map(r=>({...r,...JSON.parse(r.details)}));
 const write=names=>db.prepare('INSERT INTO company_profile VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify({...profile(),projects:names}));
 const clean=name=>{if(typeof name!=='string'||!name.trim()||name.trim().length>200||/[\x00-\x1f]/.test(name))throw requestError(400,'Enter a project name (up to 200 characters).');return name.trim();};
 const names=()=>[...new Set([...(profile().projects||[]),...rows().map(r=>r.project)].filter(Boolean))].sort((a,b)=>a.localeCompare(b));
 function list(){const records=rows();return names().map(name=>{const active=records.filter(r=>r.project===name&&!r.deleted_at),groups=new Map();for(const r of active){if(r.duplicate_of)continue;const key=r.currency||'Unknown currency',g=groups.get(key)||{currency:key,totalCents:0,unknownTotal:0};const amount=money(r.total);if(amount===null)g.unknownTotal++;else g.totalCents+=amount;groups.set(key,g);}return {name,count:active.length,canRemove:!records.some(r=>r.project===name),totals:[...groups.values()].map(g=>({...g,total:(g.totalCents/100).toFixed(2)}))};});}
 function create(name){name=clean(name);return transaction(db,()=>{const all=names();if(all.some(n=>n.toLowerCase()===name.toLowerCase()))throw requestError(409,'A project with this name already exists.');if(all.length>=100)throw requestError(400,'You can manage up to 100 projects.');write([...all,name]);return list();});}
 function rename(from,to){from=clean(from);to=clean(to);return transaction(db,()=>{const all=names();if(!all.includes(from))throw requestError(409,'This project changed. Refresh the project list.');if(to!==from&&all.some(n=>n!==from&&n.toLowerCase()===to.toLowerCase()))throw requestError(409,'A project with this name already exists.');if(from===to)return list();
 for(const r of rows().filter(r=>r.project===from)){const details={...JSON.parse(r.details),project:to},now=new Date().toISOString();db.prepare('UPDATE receipts SET details=?,updated=?,version=version+1 WHERE id=?').run(JSON.stringify(details),now,r.id);db.prepare('INSERT INTO events(receipt_id,created,type,details) VALUES(?,?,?,?)').run(r.id,now,'edited',JSON.stringify({project:{from,to}}));const files=db.prepare('SELECT name FROM files WHERE receipt_id=?').all(r.id);db.prepare('INSERT INTO receipt_search VALUES(?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text').run(r.id,searchText({...r,...details,reference:`RC-${String(r.number).padStart(5,'0')}`,files}));}
 write(all.map(n=>n===from?to:n));return list();});}
 function remove(name){name=clean(name);return transaction(db,()=>{if(rows().some(r=>r.project===name))throw requestError(409,'This project has receipts. Reassign them before removing it, including receipts in Trash.');write(names().filter(n=>n!==name));return list();});}
 return {list,create,rename,remove};
}
