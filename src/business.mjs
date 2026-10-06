import {filingFields} from '../public/receipt-policy.mjs';
import {categories,categoryNames} from '../public/categories.mjs';
export {categories,categoryNames};
export const blankDetails={title:'',merchant:'',date:'',total:'',subtotal:'',tax:'',gst:'',hst:'',pst:'',qst:'',tip:'',currency:'',category:'',payer:'',paymentType:'',reimbursement:'',project:'',purpose:'',people:'',vehicle:'',status:'review'};
export const defaultProfile={name:'',province:'',fiscalYearEnd:'',gstHstRegistered:'unknown',vehicleOwnership:'unknown',businessModel:'Two-person Canadian company providing client services',people:[],vehicles:[],projects:[]};
export function validateProfile(input){
  const out={...defaultProfile};
  for(const key of ['name','province','fiscalYearEnd','gstHstRegistered','vehicleOwnership','businessModel']){
    if(typeof input[key]!=='string'||input[key].length>300)throw new Error(`Invalid company ${key}.`);out[key]=input[key].trim();
  }
  if(!['yes','no','unknown'].includes(out.gstHstRegistered)||!['company','personal','mixed','unknown'].includes(out.vehicleOwnership))throw new Error('Invalid registration or vehicle ownership.');
  if(out.fiscalYearEnd&&(!/^\d{2}-\d{2}$/.test(out.fiscalYearEnd)||!Number.isFinite(Date.parse('2024-'+out.fiscalYearEnd))||new Date('2024-'+out.fiscalYearEnd).toISOString().slice(5,10)!==out.fiscalYearEnd))throw new Error('Use MM-DD for the fiscal year end.');
  for(const key of ['people','vehicles','projects']){
    if(!Array.isArray(input[key])||input[key].length>100||input[key].some(v=>typeof v!=='string'||v.length>200))throw new Error(`Invalid ${key}.`);
    out[key]=[...new Set(input[key].map(s=>s.trim()).filter(Boolean))];
  }
  return out;
}
export function missingFields(receipt){
  const required=filingFields;
  return required.filter(key=>!receipt[key]);
}
export function money(value){return /^\d{1,9}(\.\d{1,2})?$/.test(value||'')?Math.round(Number(value)*100):null;}
export function fiscalPeriod(end,year){
  if(!end||!Number.isInteger(year)||year<2000||year>2200)throw new Error('Set the fiscal year end first.');
  const [month,day]=end.split('-').map(Number);
  if(!/^\d{2}-\d{2}$/.test(end)||month<1||month>12||day<1||day>new Date(Date.UTC(2024,month,0)).getUTCDate())throw new Error('Invalid fiscal year end.');
  const boundary=y=>new Date(Date.UTC(y,month-1,Math.min(day,new Date(Date.UTC(y,month,0)).getUTCDate())));
  const to=boundary(year).toISOString().slice(0,10),start=boundary(year-1);start.setUTCDate(start.getUTCDate()+1);
  return {from:start.toISOString().slice(0,10),to};
}
export function summarise(records){
 records=records.filter(r=>!r.duplicatePending);
  const groups=new Map();
  for(const r of records){const key=[r.currency,r.category||'unclassified',r.status].join('|');const g=groups.get(key)||{currency:r.currency,category:r.category||'unclassified',status:r.status,count:0,totalCents:0,taxCents:0,unknownTotal:0,unknownTax:0};g.count++;const t=money(r.total),tax=money(r.tax);if(t===null)g.unknownTotal++;else g.totalCents+=t;if(tax===null)g.unknownTax++;else g.taxCents+=tax;groups.set(key,g);}
  return [...groups.values()].map(g=>({...g,total:(g.totalCents/100).toFixed(2),tax:(g.taxCents/100).toFixed(2)}));
}
