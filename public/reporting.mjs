import {categoryNames} from './categories.mjs';
export const groupLabel=(group,key)=>group==='category'?(categoryNames[key]||'Unclassified'):group==='project'?(key||'Default'):key;
export function sortedGroups(groups,group,sort='total',direction='desc'){
 const name=g=>groupLabel(group,g.key);
 return [...groups].sort((a,b)=>(direction==='asc'?1:-1)*(sort==='name'?name(a).localeCompare(name(b)):sort==='count'?a.count-b.count:a.total-b.total)||name(a).localeCompare(name(b)));
}
export function summaryCSV({report,trend,group,currency,params,view},sort='total',direction='desc'){
 const rows=[['Group','Row type','Name','Receipts','Total','Recorded tax','Share (%)','Missing tax amounts','Currency','From','Through','Project filter','Category filter']];
 const scope=[currency,params.from||'',params.to||'',params.project||'All projects',params.category?groupLabel('category',params.category):'All categories'];
 const sections=view==='overview'&&trend?[{report,group},{report:trend,group:'month'}]:[{report,group}];
 for(const section of sections){
  const r=section.report,g=section.group,groups=view==='table'?sortedGroups(r.groups,g,sort,direction):r.groups;
  for(const row of groups)rows.push([g,'Detail',groupLabel(g,row.key),row.count,(row.total/100).toFixed(2),((row.tax||0)/100).toFixed(2),r.totals.total?(100*row.total/r.totals.total).toFixed(1):'',row.unknownTax||0,...scope]);
  rows.push([g,'Total','Total',r.totals.count,(r.totals.total/100).toFixed(2),(r.totals.tax/100).toFixed(2),r.totals.total?'100.0':'',r.totals.unknownTax,...scope]);
 }
 const cell=value=>{let v=String(value??'');if(/^[\s]*[=+@-]|^[\t\r\n]/.test(v))v="'"+v;return '"'+v.replaceAll('"','""')+'"';};
 return '\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n');
}
