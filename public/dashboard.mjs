// Aggregate stored bookkeeping values only. Unaccepted model suggestions never enter totals.
export function dashboard(records,year,currency,month='',options={}){
  const cents=value=>/^\d{1,9}(\.\d{1,2})?$/.test(value||'')?Math.round(Number(value)*100):null;
  const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  const months=Array.from({length:12},(_,i)=>({month:String(i+1).padStart(2,'0'),total:0,reviewed:0,pending:0,count:0,unknown:0}));
  const annual=records.filter(r=>validDate(r.date)&&(!year||r.date.startsWith(`${year}-`))&&(!options.from||r.date>=options.from)&&(!options.to||r.date<=options.to)&&r.currency===currency);
  for(const r of annual){const group=months[Number(r.date.slice(5,7))-1],amount=cents(r.total);group.count++;if(amount===null)group.unknown++;else{group.total+=amount;group[r.status==='complete'?'reviewed':'pending']+=amount;}}
  const selected=annual.filter(r=>!month||r.date.slice(5,7)===month);
  const totals={total:0,tax:0,reviewed:0,pendingAmount:0,fuel:0,meals:0,count:selected.length,pending:0,unknownTotal:0,unknownTax:0};
  const categories=new Map();
  for(const r of selected){const amount=cents(r.total),tax=cents(r.tax),key=r.category||'unclassified';const cat=categories.get(key)||{category:key,total:0,count:0,unknown:0};cat.count++;if(r.status!=='complete'&&!r.processing)totals.pending++;if(amount===null){totals.unknownTotal++;cat.unknown++;}else{totals.total+=amount;cat.total+=amount;totals[r.status==='complete'?'reviewed':'pendingAmount']+=amount;if(['fuel','meals'].includes(key))totals[key]+=amount;}if(tax===null)totals.unknownTax++;else totals.tax+=tax;categories.set(key,cat);}
  const groups=new Map();
  for(const r of selected){const key=options.group==='project'?(r.project||''):options.group==='year'?r.date.slice(0,4):options.group==='day'?r.date:options.group==='month'?r.date.slice(0,7):(r.category||'unclassified');const g=groups.get(key)||{key,total:0,count:0,tax:0,unknownTax:0};g.count++;g.total+=cents(r.total)||0;const tax=cents(r.tax);if(tax===null)g.unknownTax++;else g.tax+=tax;groups.set(key,g);}
  return {groups:[...groups.values()].sort((a,b)=>['day','month','year'].includes(options.group)?a.key.localeCompare(b.key):b.total-a.total),months,totals,categories:[...categories.values()].sort((a,b)=>b.total-a.total),undated:records.filter(r=>!validDate(r.date)).length,missingCurrency:records.filter(r=>!r.currency).length,unaccepted:records.filter(r=>!r.total&&r.ai?.status==='ready').length};
}
