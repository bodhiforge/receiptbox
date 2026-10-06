import {blankDetails} from './business.mjs';
import {normal,filterError,receiptName} from '../public/receipts.mjs';
import {dashboard} from '../public/dashboard.mjs';
import {requestError} from './receipts.mjs';

const field=key=>`json_extract(r.details,'$.${key}')`;
const unaccepted=`EXISTS(SELECT 1 FROM receipt_ai a WHERE a.id=(SELECT max(id) FROM receipt_ai WHERE receipt=r.id) AND a.status='ready' AND NOT EXISTS(SELECT 1 FROM events e WHERE e.receipt_id=r.id AND e.type IN ('recognition_accepted','recognition_applied') AND json_extract(e.details,'$.job')=a.id))`;
const processing=`r.duplicate_of IS NULL AND ${field('status')}!='complete' AND EXISTS(SELECT 1 FROM receipt_ai a WHERE a.id=(SELECT max(id) FROM receipt_ai WHERE receipt=r.id) AND a.status IN ('queued','running'))`;
const record=row=>{
  const r={...row,...blankDetails,...JSON.parse(row.details),reference:`RC-${String(row.number).padStart(5,'0')}`};
  if(row.duplicate_of){r.status='review';r.duplicatePending=true;r.processing=false;}delete r.details;r.displayName=receiptName(r);return r;
};

export function createQueries(db) {
  function conditions(f={}) {
    const error=filterError(f);if(error)throw requestError(400,error);
    const clauses=[f.status==='trash'?'r.deleted_at IS NOT NULL':'r.deleted_at IS NULL'],args=[];
    const add=(sql,...values)=>{clauses.push(sql);args.push(...values);};
    if(f.status==='pending')add(`(r.duplicate_of IS NOT NULL OR (${field('status')}!='complete' AND NOT (${processing})))`);
    else if(f.status==='processing')add(processing);
    else if(f.status&&f.status!=='all'&&f.status!=='trash'){
      if(!['review','missing','complete'].includes(f.status))throw requestError(400,'Invalid review status.');
      add(`r.duplicate_of IS NULL AND ${field('status')}=?`,f.status);
    }
    if(f.excludeDuplicates==='1')add('r.duplicate_of IS NULL');
    if(f.unassigned==='1')add(`coalesce(${field('project')},'')=''`);
    if(f.dated==='1')add(`${field('date')}!=''`);
    if(f.category)add(`${field('category')}=?`,f.category==='unclassified'?'':f.category);
    if(f.currency)add(`${field('currency')}=?`,f.currency);
    if(f.year==='undated')add(`${field('date')}=''`);
    else if(f.year){
      if(!/^\d{4}$/.test(f.year))throw requestError(400,'Invalid year.');
      add(`${field('date')}>=? AND ${field('date')}<=?`,f.year+'-01-01',f.year+'-12-31');
    }
    if(f.month){if(!/^(0[1-9]|1[0-2])$/.test(f.month))throw requestError(400,'Invalid month.');add(`substr(${field('date')},6,2)=?`,f.month);}
    for(const key of ['from','to'])if(f[key]){
      const date=f[key];
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw requestError(400,'Invalid date.');
      add(`${field('date')}!='' AND ${field('date')}${key==='from'?'>=':'<='}?`,date);
    }
    for(const key of ['min','max'])if(f[key]!==''&&f[key]!=null)add(`${field('total')}!='' AND CAST(${field('total')} AS REAL)${key==='min'?'>=':'<='}?`,Number(f[key]));
    if(f.projectExact&&f.project)add(`${field('project')}=?`,f.project);
    for(const key of ['payer','project'])if(f[key]&&!(key==='project'&&f.projectExact))add(`instr(normalise(${field(key)}),?)>0`,normal(f[key]));
    if(['date','amount','currency'].includes(f.issue))add(`${field(f.issue==='amount'?'total':f.issue)}=''`);
    if(f.issue==='recognition')add(unaccepted);
    const tokens=normal(f.search).trim().split(/\s+/).filter(Boolean);
    if(tokens.length>20||String(f.search||'').length>1000)throw requestError(400,'Search is too long.');
    for(const token of tokens)add('r.id IN (SELECT id FROM receipt_search WHERE instr(text,?)>0)',token);
    return {sql:clauses.length?' WHERE '+clauses.map(c=>'('+c+')').join(' AND '):'',args};
  }
  function list(f={}) {
    const {sql,args}=conditions(f);
    const limit=Number(f.limit||50),offset=Number(f.offset||0);
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)throw requestError(400,'Invalid page.');
    const orders={newest:'r.created DESC,r.number DESC',oldest:'r.created,r.number',date:`(${field('date')}=''),${field('date')} DESC,r.number DESC`,'amount-high':`(${field('total')}=''),CAST(${field('total')} AS REAL) DESC,r.number DESC`,'amount-low':`(${field('total')}=''),CAST(${field('total')} AS REAL),r.number DESC`};
    const order=orders[f.sort||'newest'];if(!order)throw requestError(400,'Invalid sort.');
    const total=db.prepare('SELECT count(*) n FROM receipts r'+sql).get(...args).n;
    const items=db.prepare('SELECT r.*, ('+processing+') processing FROM receipts r'+sql+' ORDER BY '+order+' LIMIT ? OFFSET ?').all(...args,limit,offset).map(row=>{
      const r=record(row);
      r.files=db.prepare('SELECT id,name,mime,size,created FROM files WHERE receipt_id=? ORDER BY created,id LIMIT 1').all(r.id);
      return r;
    });
    return {items,total,offset,limit,hasMore:offset+items.length<total};
  }
  function facets() {
    const c=db.prepare(`SELECT count(*) total,coalesce(sum(r.duplicate_of IS NULL AND ${field('status')}='complete'),0) complete,coalesce(sum(${processing}),0) processing FROM receipts r WHERE r.deleted_at IS NULL`).get();
    return {...c,pending:c.total-c.complete-c.processing,originals:db.prepare('SELECT count(*) n FROM documents').get().n,
      years:db.prepare(`SELECT DISTINCT substr(${field('date')},1,4) value FROM receipts r WHERE r.deleted_at IS NULL AND ${field('date')}!='' ORDER BY value DESC`).all().map(r=>r.value),
      currencies:db.prepare(`SELECT DISTINCT ${field('currency')} value FROM receipts r WHERE r.deleted_at IS NULL AND ${field('currency')}!='' ORDER BY value`).all().map(r=>r.value)};
  }
  function report({year,currency,month='',project='',mode='',from='',to='',category='',group='category'}) {
    if(mode==='range'){
      if(!['CAD','USD','EUR','GBP','JPY','TWD'].includes(currency)||!['category','project','day','month','year'].includes(group)||[from,to].some(v=>v&&(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v))||from&&to&&from>to)throw requestError(400,'Choose a valid date range and currency.');
      const rows=db.prepare(`SELECT r.details, (${processing}) processing FROM receipts r WHERE r.deleted_at IS NULL AND r.duplicate_of IS NULL AND ${field('currency')}=? AND (?='' OR ${field('project')}=?) AND (?='' OR coalesce(nullif(${field('category')},''),'unclassified')=?)`).all(currency,project,project,category,category).map(r=>({...JSON.parse(r.details),processing:Boolean(r.processing)}));
      return dashboard(rows,'',currency,'',{from,to,group});
    }
    if(!/^\d{4}$/.test(year)||!['CAD','USD','EUR','GBP','JPY','TWD'].includes(currency)||month&&!/^(0[1-9]|1[0-2])$/.test(month))throw requestError(400,'Invalid report period or currency.');
    // Load only bookkeeping values for the selected year/currency, never
    // original metadata, audit history, or extraction evidence.
    const rows=db.prepare(`SELECT r.details, (${processing}) processing FROM receipts r WHERE r.deleted_at IS NULL AND r.duplicate_of IS NULL AND ${field('currency')}=? AND ${field('date')}>=? AND ${field('date')}<=? AND (?='' OR ${field('project')}=?)`).all(currency,year+'-01-01',year+'-12-31',project,project).map(r=>({...JSON.parse(r.details),processing:Boolean(r.processing)}));
    const result=dashboard(rows,year,currency,month);
    result.undated=db.prepare(`SELECT count(*) n FROM receipts r WHERE r.deleted_at IS NULL AND ${field('date')}='' AND (?='' OR ${field('project')}=?)`).get(project,project).n;
    result.missingCurrency=db.prepare(`SELECT count(*) n FROM receipts r WHERE r.deleted_at IS NULL AND ${field('currency')}='' AND (?='' OR ${field('project')}=?)`).get(project,project).n;
    result.unaccepted=db.prepare(`SELECT count(*) n FROM receipts r WHERE r.deleted_at IS NULL AND ${field('total')}='' AND ${unaccepted} AND (?='' OR ${field('project')}=?)`).get(project,project).n;
    return result;
  }
  return {list,facets,report,conditions};
}
