import {randomBytes,createHash} from 'node:crypto';
const fail=message=>Object.assign(new Error(message),{status:400});
const hash=token=>createHash('sha256').update(token).digest('hex');
export class Members {
 constructor(db,config,clock=Date.now){this.db=db;this.config=config;this.clock=clock;db.exec(`CREATE TABLE IF NOT EXISTS bot_members(bot TEXT,user TEXT,name TEXT,joined INTEGER,removed INTEGER,PRIMARY KEY(bot,user));CREATE TABLE IF NOT EXISTS bot_invites(bot TEXT,hash TEXT,expires INTEGER,used_by TEXT,revoked INTEGER,PRIMARY KEY(bot,hash));`);}
 get c(){return this.config();}
 authorized(user){return !!this.c?.owner&&(String(user)===this.c.owner||!!this.db.prepare('SELECT 1 FROM bot_members WHERE bot=? AND user=? AND removed IS NULL').get(this.c.bot,String(user)));}
 list(){if(!this.c?.owner)return {members:[],invites:[]};return {members:[{user:this.c.owner,name:'Owner',role:'owner'},...this.db.prepare('SELECT user,name,joined FROM bot_members WHERE bot=? AND removed IS NULL AND user<>?').all(this.c.bot,this.c.owner).map(m=>({...m,role:'member'}))],invites:this.db.prepare('SELECT hash AS id,expires FROM bot_invites WHERE bot=? AND used_by IS NULL AND revoked IS NULL AND expires>?').all(this.c.bot,this.clock())};}
 invite(){if(!this.c?.owner)throw fail('Pair the owner account first.');const token=randomBytes(24).toString('base64url'),expires=this.clock()+86400000;this.db.prepare('INSERT INTO bot_invites VALUES(?,?,?,NULL,NULL)').run(this.c.bot,hash(token),expires);return {link:`https://t.me/${this.c.username}?start=join_${token}`,expires};}
 valid(token){return typeof token==='string'&&!!this.c?.owner&&!!this.db.prepare('SELECT 1 FROM bot_invites WHERE bot=? AND hash=? AND expires>? AND used_by IS NULL AND revoked IS NULL').get(this.c.bot,hash(token),this.clock());}
 join(token,user,name){if(this.authorized(user))return false;this.db.exec('BEGIN IMMEDIATE');try{if(!this.valid(token))throw fail('This invitation expired or has already been used. Ask the owner for a new one.');this.db.prepare('UPDATE bot_invites SET used_by=? WHERE bot=? AND hash=?').run(String(user),this.c.bot,hash(token));this.db.prepare('INSERT INTO bot_members VALUES(?,?,?,?,NULL) ON CONFLICT(bot,user) DO UPDATE SET name=excluded.name,joined=excluded.joined,removed=NULL').run(this.c.bot,String(user),String(name||'Member').slice(0,100),this.clock());this.db.exec('COMMIT');return true;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 remove(user){if(String(user)===this.c?.owner)throw fail('The owner cannot be removed.');this.db.prepare('UPDATE bot_members SET removed=? WHERE bot=? AND user=?').run(this.clock(),this.c.bot,String(user));}
 revoke(id){this.db.prepare('UPDATE bot_invites SET revoked=? WHERE bot=? AND hash=?').run(this.clock(),this.c.bot,String(id));}
}
export function canManageMembers({cloudflare,identity,ownerEmail}){return !cloudflare||Boolean(ownerEmail&&identity?.email?.toLowerCase()===ownerEmail.toLowerCase());}
