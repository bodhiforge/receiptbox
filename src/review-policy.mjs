import {filingFields} from '../public/receipt-policy.mjs';
import {money} from './business.mjs';

export const policyVersion='exception-only-v7-subtotal-evidence';
const amounts=['subtotal','total','tax','gst','hst','pst','qst','tip'];
const normal=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
function supported(key,item){
  const {value,evidence}=item;
  if(!value||!evidence)return false;
  if(amounts.includes(key))return (evidence.match(/\d[\d,]*(?:\.\d{1,2})?/g)||[]).some(v=>money(v.replaceAll(',',''))===money(value));
  if(key==='date'){
    if(evidence.includes(value))return true;
    const [y,m,d]=value.split('-').map(Number);
    const month=['January','February','March','April','May','June','July','August','September','October','November','December'][m-1];
    if(new RegExp(`\\b${month.slice(0,3)}[a-z]*\\b`,'i').test(evidence)&&new RegExp(`\\b0?${d}\\b`).test(evidence)&&evidence.includes(String(y)))return true;
    const parts=evidence.match(/\b(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})\b/);
    if(!parts)return false;
    const [a,b,c]=parts.slice(1).map(Number);
    return (a===y&&b===m&&c===d)||(c===y&&((a===m&&b===d&&(b>12||a===b))||(a===d&&b===m&&a>12)));
  }
  if(key==='currency')return new RegExp(`\\b${value}\\b`,'i').test(evidence)||(value==='CAD'&&/canada|canadian|\b(?:BC|AB|ON|QC|NS|NB|MB|SK|NL|PE|NT|NU|YT)\b|\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i.test(evidence));
  if(key==='merchant')return normal(evidence).includes(normal(value));
  return item.confidence!=='low';
}
function currencyChoice(result){
  // Model explanations are not printed currency evidence. Prefer independent
  // local OCR lines; fall back to short receipt excerpts for older results.
  const notes=/\b(?:no|not|without|unknown|ambiguous|default|assum\w*|infer\w*|suggest\w*|likely|probably|format|unidentifiable|unspecified)\b|[- ]like\b/i;
  const excerpts=Object.values(result.fields||{}).flatMap(f=>String(f.evidence||'').split(/\n|;/)).filter(line=>!notes.test(line));
  const ocr=result.localCurrencyEvidence||[];
  const evidence=(ocr.length?ocr:excerpts).join('\n');
  const found=new Set(evidence.match(/\b(?:CAD|USD|EUR|GBP|JPY|TWD|AUD|NZD|CHF|CNY|HKD|SGD|MXN)\b/gi)?.map(v=>v.toUpperCase())||[]);
  for(const [code,pattern] of [['CAD',/(?:CA|C)\$/],['USD',/US\$/],['EUR',/€/],['GBP',/£/],['TWD',/NT\$/],['JPY',/JP[¥￥]/]])if(pattern.test(evidence))found.add(code);
  if(found.size>1)return {issue:true};
  if(found.size===1){const value=[...found][0];return ['CAD','USD','EUR','GBP','JPY','TWD'].includes(value)?{value,source:'receipt'}:{issue:true};}

  // A bare yen/yuan symbol is foreign but ambiguous, not missing information.
  if(/[¥￥]/.test(evidence))return {issue:true};

  return {value:'CAD',source:'company_default'};
}
// Confidence is a model opinion, not a calibrated probability. Filing is based on
// supported fields and concrete inconsistencies; absent optional data stays unknown.
export function assessRecognition(receipt,result,{now=new Date(),fillMissing=true}={}){
  const values={},issues=[];
  const edited=new Set(receipt.events.filter(e=>e.type==='edited').flatMap(e=>Object.keys(e.details)));
  const rejected=new Set();
  const subItem=result.fields.subtotal;
  // Subtotal has a distinct accounting meaning. A current balance, sales line
  // or amount due is not evidence of a pre-tax subtotal, even if numeric.
  // Human-entered subtotals remain authoritative through the edited-field guard.
  const explicitSubtotal=/sub[ -]?total|before tax|pre[ -]?tax|net amount/i.test(subItem?.evidence||'');
  if(subItem?.value&&!explicitSubtotal)rejected.add('subtotal');
  for(const key of ['gst','hst','pst','qst']){
    const item=result.fields[key];
    if(!item?.value)continue;
    const amount=money(item.value),total=money(receipt.total||result.fields.total?.value);
    if(/^\d{9,}$/.test(item.value)||/registration|reg\.?\s*(?:no|#)|\bRT\d{4}\b/i.test(item.evidence)||(total!==null&&amount>total))rejected.add(key);
  }
  for(const key of rejected)if(!edited.has(key)&&receipt[key]===result.fields[key]?.value)values[key]='';
  for(const [key,item] of Object.entries(result.fields)){
    if(key==='currency'||rejected.has(key)||!fillMissing)continue;
    if(receipt[key]||edited.has(key))continue;
    if(supported(key,item))values[key]=item.value;
    else if(item.value&&['date','total','tax','currency'].includes(key))issues.push({field:key,code:'unsupported',message:`Check ${key}: the extracted value is not supported by its evidence.`});
  }
  let currencySource;
  if(!receipt.currency){
    const choice=currencyChoice(result);
    if(choice.issue)issues.push({field:'currency',code:'unsupported',message:'The receipt has conflicting or unsupported currency information.'});
    else {values.currency=choice.value;currencySource=choice.source;}
  }
  const combined={...receipt,...values};
  for(const key of filingFields)if(!combined[key]&&!issues.some(i=>i.field===key))issues.push({field:key,code:'missing',message:`Add the ${key}; it could not be read.`});
  const total=money(combined.total),tax=money(combined.tax),sub=money(combined.subtotal),tip=money(combined.tip);
  if(total!==null&&tax!==null&&tax>total)issues.push({field:'tax',code:'tax_exceeds_total',message:'Tax exceeds the total. Check these two amounts.'});
  // A missing tip is not zero. Only reject provable arithmetic conflicts.
  if(total!==null&&sub!==null&&tax!==null&&((tip!==null&&Math.abs(total-sub-tax-tip)>2)||(tip===null&&sub+tax>total+2)))issues.push({field:'total',code:'arithmetic',message:'The printed amounts conflict. Check the total, subtotal and tax.'});
  if(combined.date&&combined.date>new Date(now.getTime()+86400000).toISOString().slice(0,10))issues.push({field:'date',code:'future_date',message:'The receipt date is in the future. Check the date.'});
  if(!['receipt','invoice'].includes(result.documentKind))issues.push({field:'document',code:'document_kind',message:'Check the document: it may be incomplete or not an expense receipt.'});
  // Keep raw model warnings as evidence. Only specific transaction exceptions
  // affect filing, never generic business-purpose or tax-eligibility commentary.
  for(const warning of result.warnings||[])if(/multiple (?:independent )?transactions|refund|negative amount/i.test(warning))issues.push({field:'document',code:'transaction',message:warning});
  return {version:policyVersion,values,issues,...(currencySource?{currencySource}:{}),decision:issues.length?'attention':'file'};
}
