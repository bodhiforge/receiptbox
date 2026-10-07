// Printed receipt dates are interpreted here, not by the model. A numeric date
// such as 10/07/2026 has two valid readings; the model only copies the printed
// text and this module decides from evidence or leaves the choice to a person.
const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
// Upload-time resolution: the nearest reading must be recent and every other
// reading clearly older. Late batch uploads (weeks after purchase) stay a choice.
export const recentDays=14,clearlyOlderDays=60;
const day=86400000;

const iso=(y,m,d)=>{
  if(!(m>=1&&m<=12&&d>=1&&d<=31&&y>=1990&&y<=2100))return null;
  const value=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  return new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value?value:null;
};
const year=v=>v.length===2?2000+Number(v):Number(v);

// Every valid interpretation of the first date-like text, plus the printed
// form so a person can see what the choice is about.
export function dateCandidates(text){
  const s=String(text||'').normalize('NFKC');
  let m=s.match(/\b(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})\b/);
  if(m)return {printed:m[0],values:[iso(+m[1],+m[2],+m[3])].filter(Boolean),order:'ymd'};
  m=s.match(/\b(\d{1,2})[ \-.]?([A-Za-z]{3,9})\.?[ \-.,]*(\d{4}|\d{2})\b/);
  const named=m&&months.indexOf(m[2].slice(0,3).toLowerCase());
  if(m&&named>=0)return {printed:m[0],values:[iso(year(m[3]),named+1,+m[1])].filter(Boolean),order:'named'};
  m=s.match(/\b([A-Za-z]{3,9})\.?[ \-]*(\d{1,2})(?:st|nd|rd|th)?,?[ \-]*(\d{4})\b/);
  const named2=m&&months.indexOf(m[1].slice(0,3).toLowerCase());
  if(m&&named2>=0)return {printed:m[0],values:[iso(+m[3],named2+1,+m[2])].filter(Boolean),order:'named'};
  m=s.match(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})\b/);
  if(m){
    const [a,b,y]=[+m[1],+m[2],year(m[3])];
    const values=[...new Set([iso(y,a,b),iso(y,b,a)].filter(Boolean))];
    return {printed:m[0],values,order:'numeric'};
  }
  return {printed:'',values:[],order:null};
}

// Another numeric date on the same receipt with a part above 12 shows the
// printer's day/month order (for example a card slip printed 15/09/2026).
export function printedOrder(lines){
  const found=new Set();
  for(const line of lines||[])for(const m of String(line).matchAll(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](?:\d{4}|\d{2})\b/g)){
    const [a,b]=[+m[1],+m[2]];
    if(a>12&&b<=12)found.add('dmy');
    if(b>12&&a<=12)found.add('mdy');
  }
  return found.size===1?[...found][0]:null;
}

// Returns {value,source} when the evidence settles the date, or
// {candidates,printed} when a person has to choose.
export function resolveDate({evidence,uploadedAt,lines=[]}){
  const {printed,values,order}=dateCandidates(evidence);
  if(!values.length)return {printed,candidates:[]};
  if(values.length===1)return {value:values[0],source:'printed',printed};
  const [a,b]=printed.split(/[/.\-]/).map(Number);
  const hint=order==='numeric'&&printedOrder(lines);
  if(hint){
    const [m,d]=hint==='mdy'?[a,b]:[b,a];
    const value=values.find(v=>Number(v.slice(5,7))===m&&Number(v.slice(8,10))===d);
    if(value)return {value,source:'printed_order',printed};
  }
  const upload=Date.parse(uploadedAt);
  if(Number.isFinite(upload)){
    const uploadDay=Date.parse(new Date(upload).toISOString().slice(0,10)+'T00:00:00Z');
    // One day of slack covers time zones between the till and the server.
    const age=v=>(uploadDay-Date.parse(v+'T00:00:00Z'))/day;
    const possible=values.filter(v=>age(v)>=-1);
    if(possible.length===1)return {value:possible[0],source:'upload_time',printed,candidates:values};
    const sorted=possible.sort((x,y)=>age(x)-age(y));
    if(sorted.length>1&&age(sorted[0])<=recentDays&&sorted.slice(1).every(v=>age(v)>=clearlyOlderDays))return {value:sorted[0],source:'upload_time',printed,candidates:values};
  }
  return {printed,candidates:values};
}
