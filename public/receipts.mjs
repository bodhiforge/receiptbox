import {categoryNames as categoryLabels} from './categories.mjs';
// Receipts without a project are shown under this label, so no real project may take the name.
export const defaultProjectLabel='Default';
export const reservedProjectMessage=`“${defaultProjectLabel}” is reserved for receipts without a project. Choose another project name.`;
export const isReservedProjectName=name=>typeof name==='string'&&name.trim().toLowerCase()===defaultProjectLabel.toLowerCase();
export function receiptLabel(r){
  if(r.title?.trim())return r.title.trim();
  if(r.merchant?.trim())return r.merchant.trim();
  const filename=r.files?.find(f=>f.name&&!/^telegram-photo-\d+\./.test(f.name))?.name;
  return [categoryLabels[r.category]||filename||'Receipt',r.date].filter(Boolean).join(' · ');
}
export function receiptName(r){
  if(r.title?.trim())return r.title.trim();
  const parts=[r.date||`Uploaded ${(r.created||'').slice(0,10)}`,r.merchant||categoryLabels[r.category]||'Receipt'];
  if(r.total)parts.push(`${r.currency?r.currency+' ':''}${r.total}`);
  parts.push(r.reference||'');return parts.filter(Boolean).join(' · ');
}
export const normal=value=>String(value||'').normalize('NFKC').toLowerCase();
export const searchText=r=>normal([receiptName(r),r.reference,r.merchant,r.date,r.total,r.tax,r.currency,r.category,categoryLabels[r.category],r.purpose,r.payer,r.project,r.people,r.vehicle,r.reimbursement,...(r.files||[]).map(file=>file.name)].join(' '));
export function findReceipts(records,f={}){
  const tokens=normal(f.search).trim().split(/\s+/).filter(Boolean);
  const result=records.filter(r=>{
    if(f.status==='pending'&&(r.status==='complete'||r.processing))return false;
    if(f.status==='processing'&&!r.processing)return false;
    if(f.status&&f.status!=='all'&&f.status!=='pending'&&f.status!=='processing'&&r.status!==f.status)return false;
    if(f.category&&(f.category==='unclassified'?Boolean(r.category):r.category!==f.category))return false;
    if(f.currency&&r.currency!==f.currency)return false;
    if(f.year&&(f.year==='undated'?Boolean(r.date):!r.date?.startsWith(f.year)))return false;
    if(f.month&&r.date?.slice(5,7)!==f.month)return false;
    if(f.from&&(!r.date||r.date<f.from)||f.to&&(!r.date||r.date>f.to))return false;
    if(f.min!==''&&f.min!=null&&(!r.total||Number(r.total)<Number(f.min)))return false;
    if(f.max!==''&&f.max!=null&&(!r.total||Number(r.total)>Number(f.max)))return false;
    if(f.payer&&!normal(r.payer).includes(normal(f.payer)))return false;
    if(f.project&&!normal(r.project).includes(normal(f.project)))return false;
    if(f.issue==='date'&&r.date||f.issue==='amount'&&r.total||f.issue==='currency'&&r.currency)return false;
    if(f.issue==='recognition'&&!(r.ai?.status==='ready'&&!r.events?.some(e=>['recognition_accepted','recognition_applied'].includes(e.type)&&e.details?.job===r.ai.id)))return false;
    const haystack=searchText(r);
    return tokens.every(token=>haystack.includes(token));
  });
  const direction=f.sort==='oldest'?1:-1;
  return result.sort((a,b)=>{
    if(['amount-high','amount-low'].includes(f.sort)){
      if(!a.total)return b.total?1:b.number-a.number;if(!b.total)return -1;
      return (Number(a.total)-Number(b.total))*(f.sort==='amount-high'?-1:1)||b.number-a.number;
    }
    if(f.sort==='date'){if(!a.date)return b.date?1:b.number-a.number;if(!b.date)return -1;return b.date.localeCompare(a.date)||b.number-a.number;}
    return ((a.created||'').localeCompare(b.created||'')||a.number-b.number)*direction;
  });
}
export function filterError(f){
  if(f.from&&f.to&&f.from>f.to)return 'The start date must be on or before the end date.';
  if([f.min,f.max].some(v=>v!==''&&v!=null&&(!/^\d+(\.\d{1,2})?$/.test(v))))return 'Use non-negative amounts with up to two decimal places.';
  if(f.min!==''&&f.max!==''&&f.min!=null&&f.max!=null&&Number(f.min)>Number(f.max))return 'The minimum amount must not exceed the maximum.';
  if((f.min||f.max||['amount-high','amount-low'].includes(f.sort))&&!f.currency)return 'Choose a currency before comparing amounts.';
  return '';
}
export function calendarRange(period,now=new Date()){
  const y=now.getFullYear(),m=now.getMonth();
  const start=period==='this-year'?new Date(y,0,1):new Date(y,m-(period==='last-month'?1:0),1);
  const end=period==='this-year'?new Date(y,11,31):new Date(start.getFullYear(),start.getMonth()+1,0);
  const format=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return {from:format(start),to:format(end)};
}
export function datePreset(f,now=new Date()){
  if(f.year==='undated')return 'undated';
  if(f.year||f.month)return 'custom';
  if(!f.from&&!f.to)return '';
  return ['this-month','last-month','this-year'].find(period=>{const r=calendarRange(period,now);return r.from===f.from&&r.to===f.to;})||'custom';
}
