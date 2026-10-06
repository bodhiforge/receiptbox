import {groupLabel,sortedGroups,summaryCSV} from './reporting.mjs';
import {categoryText,fieldText,receiptFeedback,issueText} from './feedback.mjs';
import {filingFields} from './receipt-policy.mjs';
import {receiptName,receiptLabel,filterError,calendarRange,datePreset} from './receipts.mjs';
const $ = selector => document.querySelector(selector);
const labels = {review:'Needs attention',missing:'Needs details',complete:'Filed',fuel:'Fuel',meals:'Meals',other:'Other',software:'Software',telecom:'Phone & internet',office:'Office supplies',equipment:'Equipment',travel:'Travel',parking:'Parking & tolls',professional:'Professional services',insurance:'Insurance',bank_fees:'Bank fees'};
const fieldLabels = {title:'Receipt name',subtotal:'Subtotal',gst:'GST',hst:'HST',pst:'PST',qst:'QST',tip:'Tip',project:'Project',paymentType:'Payment method',reimbursement:'Reimbursement',merchant:'Merchant',date:'Receipt date',total:'Total',tax:'Tax',currency:'Currency',category:'Category',payer:'Paid by',purpose:'Purpose',people:'People',vehicle:'Vehicle',status:'Status'};
Object.assign(labels,categoryText);Object.assign(fieldLabels,fieldText);
const fields = Object.keys(fieldLabels);
let receipts=[], view='all', selected=null, selectedFile=0, initialForm='', uploadFiles=[], uploadUrl=null, jobs=[], uploading=false;
const promptedDuplicates=new Set();
let toastTimer,page='receipts',facets={total:0,pending:0,complete:0,originals:0,years:[],currencies:[]},listPage={total:0,limit:50,offset:0,hasMore:false},offset=0,queryKey='',requestSequence=0,refreshTimer,detailSequence=0,dashboardSequence=0;
const filterIds={excludeDuplicates:'exclude-duplicates-filter',unassigned:'unassigned-filter',dated:'dated-filter',search:'search',category:'category-filter',year:'year-filter',month:'month-filter',currency:'currency-filter',from:'date-from-filter',to:'date-to-filter',min:'min-filter',max:'max-filter',payer:'payer-filter',project:'project-filter',issue:'issue-filter',sort:'sort-filter'};
const filterNames={excludeDuplicates:'Duplicates excluded',unassigned:'No project',dated:'Dated receipts',search:'Search',category:'Category',year:'Year',month:'Month',currency:'Currency',from:'From',to:'Through',min:'Minimum',max:'Maximum',payer:'Paid by',project:'Project',issue:'Needs attention'};
const filters=()=>({...Object.fromEntries(Object.entries(filterIds).map(([k,id])=>[k,$('#'+id).value])),status:view,projectExact:'1'});
const esc = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp = value => new Date(value).toLocaleString('en-CA',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
const friendly = (key,value) => key==='status'||key==='category' ? labels[value]||'Not set' : value||'Not set';
const notify = text => {$('#toast').textContent=text;$('#toast').hidden=false;$('#toast').showPopover?.();clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('#toast').hidePopover?.();$('#toast').hidden=true;},4500);};
async function api(path,options={}) {
  const response=await fetch(path,{...options,headers:{'X-Receiptbox':'1',...options.headers}});
  const payload=await response.json();
  if(!response.ok) throw new Error(payload.error||'Something went wrong. Please retry.');
  return payload;
}
async function refresh() {
  const sequence=++requestSequence,f=filters(),key=JSON.stringify(f);
  if(key!==queryKey){offset=0;queryKey=key;}
  const error=filterError(f);
  if(error){receipts=[];listPage={...listPage,total:0,hasMore:false};paintList();return;}
  try {
    const params=new URLSearchParams({...f,offset:String(offset),limit:'50'});
    const [result,counts]=await Promise.all([api('/api/receipts?'+params),api('/api/facets')]);
    if(sequence!==requestSequence)return;
    if(result.total&&offset>=result.total){offset=Math.floor((result.total-1)/50)*50;return refresh();}
    receipts=result.items;listPage=result;facets=counts;
    $('#load-error').hidden=true;paintList();
    if(page==='overview')renderDashboard();else if(page==='receipts')renderHome();
    const match=location.hash.match(/^#receipt=([a-f0-9-]{36})$/);
    if(match&&!$('#receipt-dialog').open)openReceipt(match[1]);
    else if(page==='receipts'&&!document.querySelector('dialog[open]')&&!uploading&&!document.activeElement?.matches('input,textarea,select')){const duplicate=receipts.find(r=>r.duplicatePending&&!promptedDuplicates.has(r.id));if(duplicate){promptedDuplicates.add(duplicate.id);openReceipt(duplicate.id);}}
  } catch(error){if(sequence!==requestSequence)return;$('#load-error').hidden=false;$('#load-error').textContent=`Could not load your records. ${error.message}`;}
}
let homeSequence=0;
async function renderHome(){
 $('#inbox-feedback').hidden=view==='trash';$('#upload-zone').hidden=view==='trash';
 if(view==='trash'){++homeSequence;return;}
 const sequence=++homeSequence,now=new Date(),year=String(now.getFullYear()),month=String(now.getMonth()+1).padStart(2,'0');
 const pending=facets.pending||0,processing=facets.processing||0;
 $('#inbox-feedback').hidden=!pending&&!processing;
 $('#inbox-feedback').className='inbox-feedback '+(pending?'has-attention':'');
 $('#inbox-feedback').innerHTML=pending?`<span><b>${pending} receipt${pending===1?'':'s'} need${pending===1?'s':''} attention.</b> </span><button type="button" id="open-exceptions">Resolve details &rarr;</button>`:`<span>${processing} receipt${processing===1?' is':'s are'} being organized. You can leave this page.</span>`;
 if($('#open-exceptions'))$('#open-exceptions').onclick=()=>document.querySelector('[data-view="pending"]').click();
 

}
function render(){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>refresh(),150);}
function paintList() {
  const pending=facets.pending;
  $('#list-title').textContent=($('#project-filter').value?$('#project-filter').value+' · ':'')+({all:'All receipts',pending:'Needs attention',processing:'Processing',complete:'Filed',trash:'Trash'})[view]||'Receipts';
  $('#processing-count').textContent=facets.processing||0;
  $('#tab-processing').hidden=!facets.processing&&view!=='processing';$('#tab-pending').classList.toggle('has-items',pending>0);
  $('#all-count').textContent=facets.total;$('#pending-count').textContent=pending;$('#complete-count').textContent=facets.complete;
  
  const currentYear=$('#year-filter').value;
  const years=[...new Set([currentYear!=='undated'?currentYear:'',...facets.years].filter(Boolean))].sort().reverse();
  $('#year-filter').innerHTML='<option value="">All years</option>'+years.map(y=>`<option>${y}</option>`).join('')+'<option value="undated">Undated</option>';
  $('#year-filter').value=currentYear;
  const f=filters(),q=f.search,category=f.category,year=f.year,error=filterError(f);
  const filtered=error?[]:receipts;
  $('#date-preset').value=datePreset(f);
  $('#filter-error').hidden=!error;$('#filter-error').textContent=error;
  const active=Object.entries(filterNames).filter(([key])=>f[key]);
  $('#clear-filters').hidden=!active.length;
  $('#active-filters').innerHTML=active.map(([key,label])=>`<button type="button" class="filter-chip" data-clear-filter="${key}">${label}${['unassigned','dated','excludeDuplicates'].includes(key)?'':': '+esc(f[key])} ×</button>`).join('')||'';
  document.querySelectorAll('[data-clear-filter]').forEach(b=>b.onclick=()=>{$('#'+filterIds[b.dataset.clearFilter]).value='';render();});
  persistFilters(f);
  $('#result-count').textContent=`${listPage.total} ${listPage.total===1?'receipt':'receipts'}`;
  $('#pagination').hidden=listPage.total<=listPage.limit;$('#page-previous').disabled=offset===0;$('#page-next').disabled=!listPage.hasMore;$('#page-range').textContent=listPage.total?`${offset+1}–${offset+filtered.length} of ${listPage.total}`:'No results';
  if(!filtered.length) {
    const empty=facets.total===0;
    $('#receipts').innerHTML=`<div class="empty-state"><div class="empty-icon" aria-hidden="true">▤</div><h3>${view==='trash'?'Trash is empty.':empty?'A clear place for every receipt.':view==='pending'&&!active.length?'You’re all caught up.':'No receipts match this view.'}</h3><p>${view==='trash'?'Deleted receipts appear here and can be restored.':empty?'Save your first receipt above. Its original and upload record will appear right here.':'Change your filters or add a new receipt.'}</p></div>`;
    return;
  }
  $('#receipts').innerHTML=filtered.map(r=>{
    const file=r.files[0]||{mime:'',id:''}, preview=file.mime.startsWith('image/')&&file.mime!=='image/heic';
    const state=r.deleted_at?['trash','In Trash']:r.processing?['processing','Reading…']:r.duplicatePending?['attention','Possible duplicate']:r.status!=='complete'?['attention',labels[r.status]]:null;
    return `<button class="receipt-row" data-id="${r.id}"><span class="receipt-thumb" aria-hidden="true">${preview?`<img src="/files/${file.id}" alt="" loading="lazy">`:file.mime==='application/pdf'?'PDF':'IMAGE'}</span><span class="receipt-info"><span class="receipt-title">${esc(receiptLabel(r))}</span><span class="receipt-meta">${r.processing?'Reading the receipt...':`${esc(r.date||'Date needed')} · ${esc(labels[r.category]||'Unclassified')}`}${r.project?` · ${esc(r.project)}`:''}</span></span><span class="receipt-right"><span class="amount">${r.total?Number(r.total).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}):'—'}<small>${esc(r.currency)}</small></span>${state?`<span class="badge ${state[0]}">${esc(state[1])}</span>`:''}</span></button>`;
  }).join('');
  document.querySelectorAll('.receipt-row').forEach(button=>button.onclick=()=>openReceipt(button.dataset.id));
}
function syncReceiptTabs(){
 document.querySelectorAll('[data-view]').forEach(button=>{const active=button.dataset.view===view;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));button.tabIndex=active||(view==='trash'&&button.dataset.view==='all')?0:-1;});
 $('#receipts').setAttribute('aria-labelledby','tab-'+(view==='trash'?'all':view));
}
document.querySelectorAll('[data-view]').forEach(button=>{
 button.onclick=()=>{view=button.dataset.view;if(page!=='receipts')showPage('receipts');syncReceiptTabs();$('#list-title').textContent=({all:'All receipts',pending:'Needs attention',processing:'Processing',complete:'Filed'})[view];render();};
 button.onkeydown=event=>{const tabs=[...document.querySelectorAll('[data-view]:not([hidden])')],index=tabs.indexOf(button);let next;
 if(event.key==='ArrowRight')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;else return;
 event.preventDefault();tabs[next].focus();tabs[next].click();};
});
$('#receipts-open').onclick=()=>{showPage('receipts');render();};

for(const id of Object.values(filterIds))$('#'+id).addEventListener(['search','min-filter','max-filter','payer-filter','project-filter'].includes(id)?'input':'change',render);
$('#more-filters').onclick=()=>{const expanded=$('#filter-details').hidden;$('#filter-details').hidden=!expanded;$('#more-filters').setAttribute('aria-expanded',String(expanded));};
$('#clear-filters').onclick=()=>{resetFilters();document.querySelector('[data-view="all"]').click();};
for(const id of ['date-from-filter','date-to-filter'])$('#'+id).addEventListener('change',()=>{$('#year-filter').value='';$('#month-filter').value='';render();});
for(const id of ['year-filter','month-filter'])$('#'+id).addEventListener('change',()=>{$('#date-from-filter').value='';$('#date-to-filter').value='';render();});
$('#page-previous').onclick=()=>{offset=Math.max(0,offset-50);refresh();};
$('#page-next').onclick=()=>{if(listPage.hasMore){offset+=50;refresh();}};
$('#camera-button').onclick=()=>$('#camera-input').click();$('#browse-button').onclick=()=>$('#files-input').click();
function choose(files) {
  const chosen=Array.from(files);if(!chosen.length)return;
  jobs.push(...chosen.map(file=>({file,state:'queued',title:''})));processQueue();
}

for(const id of ['camera-input','files-input']) $('#'+id).onchange=event=>{choose(event.target.files);event.target.value='';};
$('#upload-close').onclick=()=>$('#upload-dialog').close();
$('#upload-dialog').addEventListener('close',()=>{if(uploadUrl){URL.revokeObjectURL(uploadUrl);uploadUrl=null;}});
$('#upload-reselect').onclick=()=>{$('#upload-dialog').close();$('#files-input').click();};
$('#upload-save').onclick=()=>{
  jobs.push(...uploadFiles.map(file=>({file,state:'queued',title:uploadFiles.length===1?$('#upload-name').value.trim():''})));$('#upload-dialog').close();processQueue();
};
for(const type of ['dragenter','dragover']) $('#upload-zone').addEventListener(type,event=>{event.preventDefault();$('#upload-zone').classList.add('dragging');});
$('#upload-zone').addEventListener('dragleave',()=>$('#upload-zone').classList.remove('dragging'));
$('#upload-zone').addEventListener('drop',event=>{event.preventDefault();$('#upload-zone').classList.remove('dragging');choose(event.dataTransfer.files);});
function renderQueue() {
  $('#queue').hidden=!jobs.length;
  $('#queue').innerHTML=jobs.map((j,i)=>`<div class="queue-row"><span class="queue-name">${esc(j.displayName||j.title||j.file.name)}</span><span class="queue-state ${j.state}">${j.state==='queued'?'Waiting':j.state==='uploading'?'Saving original...':j.state==='saved'?`✓ Saved · <button class="text-button" data-job="${i}">View</button>`:j.state==='duplicate'?`Already saved · <button class="text-button" data-job="${i}">View</button>`:`${esc(j.error)} <button class="text-button" data-retry="${i}">Retry</button>`}</span></div>`).join('')+(jobs.some(j=>['saved','duplicate'].includes(j.state))?'<button class="text-button queue-clear" id="clear-finished">Dismiss saved uploads</button>':'');
  document.querySelectorAll('[data-job]').forEach(b=>b.onclick=()=>openReceipt(jobs[Number(b.dataset.job)].id));
  document.querySelectorAll('[data-retry]').forEach(b=>b.onclick=()=>{jobs[Number(b.dataset.retry)].state='queued';processQueue();});
  if($('#clear-finished'))$('#clear-finished').onclick=()=>{jobs=jobs.filter(j=>!['saved','duplicate'].includes(j.state));renderQueue();};
}
async function processQueue() {
  if(uploading){renderQueue();return;}uploading=true;
  let lastId=null,count=0;
  try {
    for(const job of jobs) {
      if(job.state!=='queued')continue;
      job.state='uploading';renderQueue();
      try {
        if(job.file.size>20*1024*1024)throw new Error('Over 20 MB. Choose a smaller file.');
        const form=new FormData();form.append('file',job.file);if(job.title)form.append('title',job.title);
        const response=await api('/api/receipts',{method:'POST',body:form});
        job.displayName=response.receipt.displayName;job.state=response.duplicate?'duplicate':'saved';job.id=response.receipt.id;lastId=job.id;count++;
      } catch(error){job.state='failed';job.error=error.message;}
      renderQueue();await refresh();
    }
  } finally {uploading=false;}
  if(count)notify(`${count} ${count===1?'file':'files'} saved. You can leave; we will organize them.`);
}
const formValues=()=>Object.fromEntries(new FormData($('#receipt-form')));
const dirty=()=>selected&&JSON.stringify(formValues())!==initialForm;
function closeDetail() {
  if(dirty()&&!confirm('Close without saving these detail changes? Your original is already saved.'))return;
  ++detailSequence;$('#receipt-dialog').close();selected=null;history.replaceState(null,'',location.pathname+location.search+(page==='receipts'?'':'#'+page));
}
$('#detail-close').onclick=closeDetail;
$('#receipt-dialog').addEventListener('cancel',event=>{event.preventDefault();closeDetail();});
window.addEventListener('beforeunload',event=>{if(dirty()||uploading||jobs.some(j=>j.state==='failed'||j.state==='queued')){event.preventDefault();event.returnValue='';}});
function categoryFields() {
  const category=$('#receipt-form').elements.category.value;
  $('#people-field').hidden=category!=='meals';$('#vehicle-field').hidden=category!=='fuel';
}
$('#receipt-form').elements.category.onchange=categoryFields;
async function openReceipt(id) {
  const sequence=++detailSequence;let record;
  try{record=await api('/api/receipts/'+id);}catch(error){notify(error.message);return;}
  if(sequence!==detailSequence)return;selected=record;
  selectedFile=0;
  $('#detail-reference').textContent=selected.reference;
  $('#detail-heading').textContent=receiptLabel(selected);
  history.replaceState(null,'',location.pathname+location.search+'#receipt='+selected.id);
  $('#saved-note').hidden=!selected.deleted_at;$('#saved-note').className='saved-note';
  const form=$('#receipt-form');
  for(const key of fields) if(form.elements[key])form.elements[key].value=selected[key];
  syncProjectOptions();if(selected.project&&!Array.from($('#receipt-project').options).some(o=>o.value===selected.project))$('#receipt-project').add(new Option(selected.project,selected.project));$('#receipt-project').value=selected.project||'';
  initialForm=JSON.stringify(formValues());categoryFields();$('#detail-error').hidden=true;
  renderOriginal();renderHistory();renderRecognition();
  const core=['merchant','date','total','tax','currency','category'];
  $('#saved-field-summary').innerHTML=`<span class="receipt-total"><small>Total</small><b>${esc(selected.currency||'')} ${esc(selected.total?Number(selected.total).toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2}):'Not yet available')}</b></span>`+['date','category','tax'].filter(k=>selected[k]).map(k=>`<span><small>${esc(fieldLabels[k])}</small><b>${esc(k==='category'?labels[selected[k]]:selected[k])}</b></span>`).join('');
  $('#receipt-fields').open=filingFields.some(key=>!selected[key]);
  $('#business-fields').open=false;
  $('#mark-complete').hidden=true;
  $('#save-draft').hidden=Boolean(selected.deleted_at);
  $('#attach-button').hidden=Boolean(selected.deleted_at);
  for(const input of form.querySelectorAll('input,select,textarea'))input.disabled=Boolean(selected.deleted_at);
  $('#recognition-panel').hidden=Boolean(selected.deleted_at);
  $('#trash-receipt').classList.toggle('is-restore',Boolean(selected.deleted_at));
  $('#trash-receipt').textContent=selected.deleted_at?'Restore receipt':'Move to Trash';
  if(selected.deleted_at)$('#saved-note').textContent='In Trash · Excluded from totals and exports. Original retained.';
  $('#document-confirm-label').hidden=!selected.ai?.result?.assessment?.issues?.some(i=>i.field==='document');
  $('#document-confirm').checked=false;
  if(!$('#receipt-dialog').open)$('#receipt-dialog').showModal();
}
let previewSequence=0,previewFile=null,previewPages=1,previewPage=0;
async function renderOriginal() {
  const file=selected.files[selectedFile],sequence=++previewSequence;
  $('#file-count').textContent=`${selected.files.length} ${selected.files.length===1?'file':'files'}`;
  $('#original-preview').innerHTML='<p class="muted">Loading preview…</p>';
  $('#file-tabs').hidden=selected.files.length<=1;
  $('#file-tabs').innerHTML=selected.files.map((f,i)=>`<button class="file-tab ${i===selectedFile?'active':''}" data-file="${i}" aria-pressed="${i===selectedFile}" title="${esc(f.name)}">File ${i+1}</button>`).join('');
  document.querySelectorAll('[data-file]').forEach(b=>b.onclick=()=>{selectedFile=Number(b.dataset.file);renderOriginal();});
  $('#download-original').href=`/files/${file.id}?download=1`;$('#saved-time').textContent=`Uploaded ${stamp(file.created)} · ${(file.size/1024).toFixed(0)} KB · Original unchanged`;
  try{
    const info=await api(`/api/files/${file.id}/preview`);
    if(sequence!==previewSequence||selected?.files[selectedFile]?.id!==file.id)return;
    $('#original-preview').innerHTML=`<button type="button" class="preview-open" aria-label="Enlarge receipt preview"><img src="/api/files/${file.id}/preview/0.jpg" alt="Receipt preview"><span>Enlarge${info.pages>1?` · ${info.pages} pages`:''}</span></button>`;
    $('.preview-open').onclick=()=>{previewFile=file;previewPages=info.pages;previewPage=0;$('#preview-zoom').value='fit';$('#preview-title').textContent=selected.displayName;showPreviewPage();$('#preview-dialog').showModal();applyPreviewZoom();};
  }catch(error){if(sequence===previewSequence)$('#original-preview').innerHTML=`<p>${esc(error.message)}</p><p>Use Download original below.</p>`;}
}
function showPreviewPage(){
  $('#preview-error').hidden=true;$('#preview-image').src=`/api/files/${previewFile.id}/preview/${previewPage}.jpg`;
  for(const id of ['preview-prev','preview-page','preview-next'])$('#'+id).hidden=previewPages<=1;
  $('#preview-page').textContent=`${previewPage+1} / ${previewPages}`;$('#preview-prev').disabled=previewPage===0;$('#preview-next').disabled=previewPage+1>=previewPages;
  $('#preview-scroll').className='preview-scroll zoom-'+$('#preview-zoom').value;
  $('#preview-scroll').scrollTop=0;$('#preview-scroll').scrollLeft=0;
}
$('#preview-image').onerror=()=>{$('#preview-error').hidden=false;};
$('#preview-prev').onclick=()=>{previewPage--;showPreviewPage();};$('#preview-next').onclick=()=>{previewPage++;showPreviewPage();};
function applyPreviewZoom(){const image=$('#preview-image'),box=$('#preview-scroll');if(!image.naturalWidth||!box.clientHeight)return;const scale=Math.min(box.clientWidth/image.naturalWidth,box.clientHeight/image.naturalHeight),factor=({fit:1,double:2,triple:3})[$('#preview-zoom').value];image.style.width=Math.max(1,Math.floor(image.naturalWidth*scale*factor))+'px';}
$('#preview-image').onload=applyPreviewZoom;
$('#preview-zoom').onchange=applyPreviewZoom;
window.addEventListener('resize',()=>{if($('#preview-dialog').open)applyPreviewZoom();});
$('#preview-close').onclick=()=>$('#preview-dialog').close();

function renderHistory() {
  $('#history-count').textContent=`(${selected.events.length})`;
  $('#history-list').innerHTML=selected.events.map(e=>`<li>${['recognition_accepted','recognition_applied'].includes(e.type)?`${e.type==='recognition_applied'?(e.details.decision==='file'?'Automatically filed':'Recognition saved; exception flagged'):'Recognition accepted'} (${esc(e.details.model)}): ${Object.keys(e.details.changes).map(esc).join(', ')}`:e.type==='duplicate_resolved'?(e.details.choice==='keep'?'Duplicate checked: kept both receipts':'Duplicate checked: used existing receipt; new upload moved to Trash'):e.type==='deleted'?'Moved to Trash':e.type==='restored'?'Restored from Trash':e.type==='document_confirmed'?'Document checked by user':e.type==='uploaded'?`Original saved: ${esc(e.details.name)}${e.details.uploadedBy?` · Uploaded by ${esc(e.details.uploadedBy.name)}`:''}`:Object.entries(e.details).map(([key,val])=>`${esc(fieldLabels[key])}: ${esc(friendly(key,val.from))} → ${esc(friendly(key,val.to))}`).join('<br>')}<time>${esc(stamp(e.created))}</time></li>`).join('');
}
async function save(status) {
  for(const input of $('#receipt-form').querySelectorAll('input,select,textarea'))if(!input.checkValidity()){for(let parent=input.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;input.reportValidity();return;}
  const id=selected.id;
  $('#save-draft').disabled=true;$('#mark-complete').disabled=true;
  try {
    const payload={...selected,...formValues(),status,autoStatus:true,confirmDocument:$('#document-confirm').checked,version:selected.version};
    const record=await api(`/api/receipts/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    selected=record;initialForm=JSON.stringify(formValues());await refresh();renderHistory();$('#detail-error').hidden=true;
    if(record.status==='complete'){closeDetail();notify('Changes saved. Receipt filed.');}
    else {await openReceipt(id);$('#detail-error').textContent='Changes saved. Check the remaining details above.';$('#detail-error').hidden=false;$('#recognition-panel').scrollIntoView({block:'nearest'});notify('Changes saved. Some details still need attention.');}
  } catch(error){$('#detail-error').textContent=error.message;$('#detail-error').hidden=false;}
  finally {$('#save-draft').disabled=false;$('#mark-complete').disabled=false;}
}
$('#trash-open').onclick=()=>{resetFilters();view='trash';showPage('receipts');syncReceiptTabs();$('#list-title').textContent='Trash';refresh();};
$('#trash-receipt').onclick=async()=>{
 const restoring=Boolean(selected.deleted_at);
 if(!restoring&&!confirm('Move this receipt to Trash? It will be removed from totals and exports. You can restore it from Settings → Trash.'))return;
 $('#trash-receipt').disabled=true;
 try{await api(`/api/receipts/${selected.id}/${restoring?'restore':'trash'}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:selected.version})});initialForm=JSON.stringify(formValues());closeDetail();await refresh();notify(restoring?'Receipt restored.':'Moved to Trash. Restore it from Settings → Trash.');}
 catch(error){$('#detail-error').textContent=error.message;$('#detail-error').hidden=false;}
 finally{$('#trash-receipt').disabled=false;}
};
$('#receipt-form').onsubmit=event=>{event.preventDefault();save(selected.status==='complete'?'complete':'missing');};$('#mark-complete').onclick=()=>save('complete');
$('#attach-button').onclick=()=>{
  if(dirty()){notify('Save your detail changes before adding another page.');return;}
  $('#attach-input').click();
};
$('#attach-input').onchange=async event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;
  const id=selected.id;$('#attach-button').disabled=true;
  try {
    if(file.size>20*1024*1024)throw new Error('Each file must be 20 MB or smaller.');
    const form=new FormData();form.append('file',file);
    const response=await api(`/api/receipts/${id}/files`,{method:'POST',body:form});
    if(response.duplicate){notify(`This original already belongs to ${response.receipt.reference}. Nothing was added.`);return;}
    await refresh();openReceipt(id);notify('Another page saved. Please review the updated receipt.');
  } catch(error){$('#detail-error').textContent=error.message;$('#detail-error').hidden=false;}
  finally{$('#attach-button').disabled=false;}
};
$('#export-open').onclick=()=>{$('#export-error').hidden=true;$('#export-project').value=$('#project-filter').value;$('#export-dialog').showModal();};$('#export-close').onclick=()=>$('#export-dialog').close();
async function exportRecords(kind) {
  const from=$('#export-from').value,to=$('#export-to').value;
  if(from&&to&&from>to){$('#export-error').hidden=false;$('#export-error').textContent='The start date must precede the end date.';return;}
  $('#export-csv').disabled=true;$('#export-zip').disabled=true;
  try {
    const url=`/api/export.${kind}?${new URLSearchParams({from,to,project:$('#export-project').value})}`;
    // The browser streams the archive download, avoiding a whole-archive Blob in memory.
    const a=document.createElement('a');a.href=url;a.download='';document.body.append(a);a.click();a.remove();
    notify('Export requested. Check your browser’s downloads for completion.');
  } finally {$('#export-csv').disabled=false;$('#export-zip').disabled=false;}
}
$('#export-period').onchange=()=>{const period=$('#export-period').value,range=period==='all'?{from:'',to:''}:period==='custom'?{from:$('#export-from').value,to:$('#export-to').value}:calendarRange(period,new Date());$('#export-from').value=range.from;$('#export-to').value=range.to;$('#export-dates').hidden=period!=='custom';};
$('#export-csv').onclick=()=>exportRecords('csv');$('#export-zip').onclick=()=>exportRecords('zip');
let botStatus=null,botPoll;
async function refreshBot() {
  try {
    botStatus=await api('/api/telegram');
    $('#bot-setup').hidden=botStatus.configured;$('#bot-connected').hidden=!botStatus.configured;
    $('#bot-open').textContent=botStatus.paired?'Open receipt bot':botStatus.configured?'Finish Telegram pairing':'Connect receipt bot';
    $('#daily-bot-link').hidden=page!=='receipts'||!botStatus.paired;if(botStatus.paired)$('#daily-bot-link').href=botStatus.link;
    if(!botStatus.configured)$('#bot-card-status').textContent='Not connected. Set up a bot to send receipts from Telegram.';
    if(botStatus.configured){
      $('#bot-link').href=botStatus.link;
      $('#bot-link').textContent=botStatus.paired?'Open receipt bot':'Open Telegram and press Start';
      $('#bot-state').textContent=botStatus.paired?`@${botStatus.username} accepts receipts from ${botStatus.memberCount||1} authorized account(s). Manage invitations in Settings → Members.`:`@${botStatus.username} is connected. Use the private link below and press Start to pair your account.`;
      $('#bot-card-status').textContent=botStatus.error|| (botStatus.paired?`@${botStatus.username} · ${botStatus.memberCount||1} authorized account(s) · Saves to Mini`:`@${botStatus.username} · Waiting for you to press Start in Telegram`);
    }
  } catch(error){$('#bot-error').hidden=false;$('#bot-error').textContent=error.message;}
}
$('#bot-open').onclick=async()=>{$('#bot-error').hidden=true;await refreshBot();$('#bot-dialog').showModal();botPoll=setInterval(refreshBot,4000);};
$('#bot-close').onclick=()=>$('#bot-dialog').close();
$('#bot-dialog').addEventListener('close',()=>{clearInterval(botPoll);$('#bot-token').value='';});
$('#bot-form').onsubmit=async event=>{
  event.preventDefault();$('#bot-connect').disabled=true;$('#bot-error').hidden=true;
  try{await api('/api/telegram',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:$('#bot-token').value})});$('#bot-token').value='';await refreshBot();}
  catch(error){$('#bot-error').hidden=false;$('#bot-error').textContent=error.message;}
  finally{$('#bot-connect').disabled=false;}
};
api('/api/config').then(config=>{
  $('#snapshot-status').textContent=config.snapshot?.verified?`Recovery snapshot checked ${stamp(config.snapshot.created)}. Stored on the same Mini; an independent backup is still needed.`:'Independent backup is not connected.';
  $('#recognition-label').textContent=config.localAI?'Recognition runs locally on Mini · Automatic filing · Exceptions only':'Local recognition not enabled';
  $('#deployment-label').textContent=config.privateRemote?'Private · Sign-in required':'Local preview';
  $('#storage-location').textContent=`Originals stay on ${config.location}.`;
}).catch(()=>{$('#storage-location').textContent='Storage connection unavailable.';});
refreshBot();
async function refreshHealth(){
  try{
    const health=await api('/api/health');
    if(health.recognition.enabled&&!health.recognition.alive)$('#recognition-label').textContent='Recognition is offline. Originals can still be saved; queued receipts will resume when it returns.';
    else $('#recognition-label').textContent=health.recognition.enabled?'Recognition runs locally on Mini · Automatic filing · Exceptions only':'Local recognition not enabled';
    const pending=health.notifications.filter(r=>r.status!=='sent').reduce((sum,r)=>sum+r.count,0);
    $('#delivery-health').textContent=health.intake.retrying?`${health.intake.retrying} incoming messages are retrying. Keep their originals until the bot confirms they are saved.`:pending?`${pending} recognition notifications are waiting for delivery.`:'No intake or notification retries need attention.';
  }catch{$('#delivery-health').textContent='Could not check background processing. Refresh to retry.';}
}


function renderRecognition(){
  const panel=$('#recognition-panel'),job=selected.ai,state=receiptFeedback(selected);
  panel.className='recognition-panel feedback-'+state.state;
  panel.innerHTML=`<div class="feedback-heading"><span class="feedback-symbol">${state.state==='filed'?'✓':state.state==='processing'?'◌':'!'}</span><div><h3>${esc(state.title)}</h3><p>${esc(state.detail)}</p></div></div>${state.issues.map(i=>`<button type="button" class="issue-action" data-issue-field="${esc(i.field)}" data-issue-code="${esc(i.code)}"><span>${esc(issueText(i))}</span><b>Fix →</b></button>`).join('')}${job?.status==='failed'?'<button type="button" class="button secondary" id="ai-retry">Retry recognition</button>':''}`;
  if(selected.possibleDuplicate)panel.innerHTML+=`<aside class="duplicate-hint"><p>Use existing moves this upload to Trash. Keep both includes both receipts.</p><a class="text-link" href="/#receipt=${esc(selected.possibleDuplicate.id)}" target="_blank" rel="noopener">View existing ↗</a><div class="duplicate-actions"><button type="button" class="button secondary" data-duplicate-choice="existing">Use existing</button><button type="button" class="button primary" data-duplicate-choice="keep">Keep both</button></div></aside>`;
  for(const button of panel.querySelectorAll('[data-duplicate-choice]'))button.onclick=async()=>{
    if(dirty()){notify('Save your edits before confirming.');return;}
    try{const record=await api(`/api/receipts/${selected.id}/duplicate`,{method:'POST',body:JSON.stringify({version:selected.version,choice:button.dataset.duplicateChoice})});notify(record.deleted_at?'Existing receipt kept. New upload moved to Trash.':'Both receipts kept.');await openReceipt(record.id);refresh();}catch(e){notify(e.message);}
  };
  if(job?.result)panel.innerHTML+=`<details class="evidence-drawer"><summary>What was read</summary>${Object.entries(job.result.fields).filter(([,v])=>v.value).map(([k,v])=>`<p><b>${esc(fieldLabels[k]||k)} · ${esc(v.value)}</b><br><small>${esc(v.evidence)}</small></p>`).join('')}<details><summary>Model notes</summary>${(job.result.warnings||[]).map(w=>`<p>${esc(w)}</p>`).join('')}</details></details>`;
  document.querySelectorAll('[data-issue-field]').forEach(button=>button.onclick=()=>{const key=button.dataset.issueField;if(button.dataset.issueCode==='arithmetic'){for(const name of ['subtotal','total','tax','tip']){const field=$('#receipt-form').elements[name];for(let parent=field?.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;}}if(key==='document'){$('#document-confirm-label').hidden=false;$('#document-confirm').focus();return;}const input=$('#receipt-form').elements[key];if(input){for(let parent=input.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;input.focus();input.scrollIntoView({block:'center',behavior:'smooth'});}});
  if($('#ai-retry'))$('#ai-retry').onclick=()=>recognitionAction('retry');
}

async function recognitionAction(action){
  if(dirty()){notify('Save your current edits before applying recognition.');return;}
  try{const record=await api(`/api/receipts/${selected.id}/recognition`,{method:'POST',body:JSON.stringify({action,job:selected.ai?.id,version:selected.version})});receipts=receipts.map(r=>r.id===record.id?record:r);openReceipt(record.id);render();}
  catch(e){notify(e.message);}
}
setInterval(async()=>{
  if(document.hidden)return;
  if(page!=='settings')await refresh();
  const id=selected?.id;
  if(id&&!dirty()&&$('#receipt-dialog').open){
    try{
      const fresh=await api('/api/receipts/'+id);
      if(selected?.id!==id||dirty()||!$('#receipt-dialog').open)return;
      if(fresh.version!==selected.version)await openReceipt(id);
      else if(JSON.stringify(fresh.ai)!==JSON.stringify(selected.ai)){selected=fresh;renderRecognition();}
    }catch{}
  }
},10000);
let company;
$('#company-open').onclick=async()=>{try{company=await api('/api/company');const form=$('#company-form');for(const [k,v] of Object.entries(company))if(form.elements[k])form.elements[k].value=Array.isArray(v)?v.join('\n'):v;$('#company-error').hidden=true;$('#company-dialog').showModal();}catch(e){notify(e.message);}};
$('#company-close').onclick=()=>$('#company-dialog').close();
$('#company-form').onsubmit=async event=>{event.preventDefault();const value=Object.fromEntries(new FormData(event.target));for(const key of ['people','vehicles'])value[key]=value[key].split('\n');try{company=await api('/api/company',{method:'PUT',body:JSON.stringify(value)});$('#workspace-company').textContent=company.name||'';$('#company-dialog').close();notify('Company context saved on Mini.');}catch(e){$('#company-error').hidden=false;$('#company-error').textContent=e.message;}};
$('#fiscal-apply').onclick=async()=>{try{company=await api('/api/company');const year=Number($('#fiscal-year').value);if(!company.fiscalYearEnd||!Number.isInteger(year)||year<2000||year>2200)throw Error('Set the company fiscal year end and enter its ending year first.');const end=company.fiscalYearEnd;const boundary=y=>{const [m,d]=end.split('-').map(Number);return new Date(Date.UTC(y,m-1,Math.min(d,new Date(Date.UTC(y,m,0)).getUTCDate())));};const from=boundary(year-1);from.setUTCDate(from.getUTCDate()+1);$('#export-from').value=from.toISOString().slice(0,10);$('#export-to').value=boundary(year).toISOString().slice(0,10);$('#export-period').value='custom';$('#export-dates').hidden=false;}catch(e){$('#export-error').hidden=false;$('#export-error').textContent=e.message;}};

function spendingRange(){const period=$('#spending-period').value;return period==='all'?{from:'',to:''}:period==='custom'?{from:$('#spending-from').value,to:$('#spending-to').value}:calendarRange(period);}
let reportView='overview',reportSort='total',reportDirection='desc',reportSnapshot=null;
const reportAmount=n=>(n/100).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
function reportChart(report,group,currency){
 const t=report.totals,amount=reportAmount;
 const temporal=['day','month','year'].includes(group),max=Math.max(1,...report.groups.map(g=>g.total));
 const groupName=g=>group==='category'?(labels[g.key]||'Unclassified'):g.key||'No project';
 const chartRows=report.groups.map((g,i)=>{const name=groupName(g),description=`${name}: ${amount(g.total)} ${currency}, ${g.count} receipts`,share=t.total?(100*g.total/t.total).toFixed(1)+'%':'—';
 if(temporal){const height=180*g.total/max;return `<button class="spending-column" data-spending-row="${i}" data-report-group="${group}" aria-label="${esc(description)}" title="${esc(description)}"><b>${amount(g.total)}</b><svg viewBox="0 0 64 184" preserveAspectRatio="xMidYMax meet" aria-hidden="true"><rect class="column-fill" x="21" y="${184-height}" width="22" height="${height}"/></svg><span>${esc(name)}</span><small>${g.count} receipt${g.count===1?'':'s'}</small></button>`;}
 return `<button class="spending-bar-row" data-spending-row="${i}" data-report-group="${group}" aria-label="${esc(description)}"><span class="spending-bar-label"><b>${esc(name)}</b><small>${g.count} receipt${g.count===1?'':'s'} · ${share}</small></span><span class="spending-bar-track"><svg viewBox="0 0 1000 6" preserveAspectRatio="none" aria-hidden="true"><rect class="bar-track" width="1000" height="6"/><rect class="bar-fill" width="${1000*g.total/max}" height="6"/></svg></span><strong>${amount(g.total)}<small>${esc(currency)}</small></strong></button>`;}).join('');
 return report.groups.length?(temporal?`<div class="spending-time-chart"><div class="spending-chart-scale"><span>${amount(max)} ${esc(currency)}</span><span>0</span></div><div class="spending-columns">${chartRows}</div></div><p class="spending-chart-caption">${esc(currency)} · Periods without receipts are omitted.</p>`:`<div class="spending-bars">${chartRows}</div>`):'<p class="muted">No dated receipts match this selection.</p>';

}
function reportTable(report,group,currency){
 const rows=sortedGroups(report.groups,group,reportSort,reportDirection);
 const heading=(key,title)=>`<th scope="col" aria-sort="${key===reportSort?(reportDirection==='asc'?'ascending':'descending'):'none'}"><button data-report-sort="${key}">${esc(title)} ${key===reportSort?(reportDirection==='asc'?'↑':'↓'):'↕'}</button></th>`;
 return `<div class="report-table-wrap"><table class="report-table"><caption class="sr-only">Expense summary in ${esc(currency)}</caption><thead><tr>${heading('name',group==='category'?'Category':group==='project'?'Project':'Period')}${heading('count','Receipts')}${heading('total',`Total (${currency})`)}<th>Tax</th><th>Share</th></tr></thead><tbody>${rows.map(g=>`<tr><td><button class="text-button" data-spending-row="${report.groups.indexOf(g)}" data-report-group="${group}">${esc(group==='category'?(labels[g.key]||'Unclassified'):g.key||'No project')}</button></td><td>${g.count}</td><td>${reportAmount(g.total)}</td><td>${reportAmount(g.tax||0)}${g.unknownTax?' *':''}</td><td>${report.totals.total?(100*g.total/report.totals.total).toFixed(1)+'%':'—'}</td></tr>`).join('')}</tbody><tfoot><tr><th>Total</th><td>${report.totals.count}</td><td>${reportAmount(report.totals.total)}</td><td>${reportAmount(report.totals.tax)}${report.totals.unknownTax?' *':''}</td><td></td></tr></tfoot></table></div><p class="form-hint">${report.totals.unknownTax?'* Some tax amounts are missing. ':''}Select a name to open its receipts.</p>`;
}
function setReportView(next){
 reportView=next;
 document.querySelectorAll('[data-report-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.reportView===next)));
 const groups=next==='trends'?['day','month','year']:next==='breakdown'?['category','project']:['category','project','day','month','year'];
 const previous=$('#spending-group').value;$('#spending-group').replaceChildren(...groups.map(g=>new Option(g[0].toUpperCase()+g.slice(1),g)));$('#spending-group').value=groups.includes(previous)?previous:next==='trends'?'month':groups[0];
 $('#spending-group-label').hidden=next==='overview';renderDashboard();
}
async function renderDashboard(){
 const sequence=++dashboardSequence,currency=$('#dashboard-currency').value||'CAD',activeView=reportView;
 $('#dashboard-currency').replaceChildren(...[...new Set(['CAD',currency,...facets.currencies])].sort().map(c=>new Option(c,c)));$('#dashboard-currency').value=currency;
 const custom=$('#spending-period').value==='custom';$('#spending-from-label').hidden=!custom;$('#spending-to-label').hidden=!custom;$('#spending-group-label').hidden=activeView==='overview';
 const range=spendingRange(),group=activeView==='overview'?'category':$('#spending-group').value;
 const params={mode:'range',currency,project:$('#spending-project').value,category:$('#spending-category').value,...range};
 reportSnapshot=null;$('#spending-download').disabled=true;$('#category-bars').setAttribute('aria-busy','true');
 let report,trend;try{[report,trend]=await Promise.all([api('/api/dashboard?'+new URLSearchParams({...params,group})),activeView==='overview'?api('/api/dashboard?'+new URLSearchParams({...params,group:'month'})):null]);}catch(e){if(sequence!==dashboardSequence)return;$('#dashboard-note').textContent=e.message;$('#dashboard-metrics').innerHTML='';$('#category-bars').innerHTML='';$('#category-bars').setAttribute('aria-busy','false');return;}
 if(sequence!==dashboardSequence)return;
 reportSnapshot={report,trend,group,currency,params,view:activeView};$('#spending-download').disabled=false;$('#category-bars').setAttribute('aria-busy','false');
 const t=report.totals,amount=reportAmount;
 const metric=(label,value,note,attention=false)=>`<div class="dashboard-metric${attention?' is-attention':''}"><small>${label}</small><strong>${value}</strong><span>${note}</span></div>`;
 $('#dashboard-metrics').innerHTML=metric('Total',`${amount(t.total)}<small>${esc(currency)}</small>`,`${t.count} receipt${t.count===1?'':'s'}`)+metric('Average per receipt',amount(t.count-t.unknownTotal?t.total/(t.count-t.unknownTotal):0),'Known amounts only')+metric('Tax recorded',amount(t.tax),`${esc(currency)}${t.unknownTax?' · incomplete':''}`)+metric('Needs attention',t.pending,`${amount(t.pendingAmount)} ${esc(currency)} provisional`,t.pending>0);
 $('#spending-group-title').textContent=activeView==='overview'?'At a glance':activeView==='trends'?'Expenses over time':activeView==='table'?'Summary table':'Where expenses go';
 paintReport();
}
function paintReport(){
 if(!reportSnapshot)return;
 const {report,trend,group,currency,view:activeView}=reportSnapshot,t=report.totals;
 const markup=!report.groups.length?'<div class="report-empty"><h3>No expenses in this selection</h3><p>Try another period, project or category.</p></div>':activeView==='overview'?`<div class="report-overview"><section class="report-panel"><h3>Over time</h3>${reportChart(trend,'month',currency)}</section><section class="report-panel"><h3>By category</h3>${reportChart(report,'category',currency)}</section></div>`:activeView==='table'?reportTable(report,group,currency):reportChart(report,group,currency);
 const focusSort=document.activeElement?.dataset.reportSort;
 if($('#category-bars').innerHTML!==markup)$('#category-bars').innerHTML=markup;
 const gaps=[t.unknownTotal&&`${t.unknownTotal} without a total`,t.unknownTax&&`${t.unknownTax} without tax`,report.undated&&`${report.undated} undated, not shown`].filter(Boolean);
 $('#dashboard-note').textContent=`By receipt date. Includes receipts that need attention; unconfirmed duplicates are excluded.${gaps.length?' '+gaps.join(' · ')+'.':''}`;
 document.querySelectorAll('[data-spending-row]').forEach(b=>b.onclick=()=>{const source=b.dataset.reportGroup==='month'&&trend?trend:report;drillDashboard({group:b.dataset.reportGroup,key:source.groups[Number(b.dataset.spendingRow)].key});});
 document.querySelectorAll('[data-report-sort]').forEach(b=>b.onclick=()=>{const next=b.dataset.reportSort;reportDirection=next===reportSort?(reportDirection==='asc'?'desc':'asc'):next==='name'?'asc':'desc';reportSort=next;paintReport();});
 if(focusSort)document.querySelector(`[data-report-sort="${focusSort}"]`)?.focus({preventScroll:true});
 const message=`Showing ${t.count} receipts in ${currency}.`+(activeView==='table'?` Sorted by ${reportSort==='name'?'name':reportSort==='count'?'receipt count':'total'}, ${reportDirection==='asc'?'ascending':'descending'}.`:'');
 if($('#report-status').textContent!==message)$('#report-status').textContent=message;
}
document.querySelectorAll('[data-report-view]').forEach(b=>b.onclick=()=>setReportView(b.dataset.reportView));
$('#spending-download').onclick=()=>{
 if(!reportSnapshot)return;const {report,group,currency,params}=reportSnapshot;
 const url=URL.createObjectURL(new Blob([summaryCSV(reportSnapshot,reportSort,reportDirection)],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`expenses-${reportSnapshot.view==='overview'?'overview':group}-${params.from||'all'}-${params.to||'time'}-${currency}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};

function drillDashboard(row=null){
 const range=spendingRange(),currency=$('#dashboard-currency').value,project=$('#spending-project').value,category=$('#spending-category').value;
 resetFilters();view='all';$('#exclude-duplicates-filter').value='1';$('#dated-filter').value='1';$('#date-from-filter').value=range.from;$('#date-to-filter').value=range.to;$('#currency-filter').value=currency;$('#project-filter').value=project;$('#category-filter').value=category;
 if(row){if(row.group==='category')$('#category-filter').value=row.key;else if(row.group==='project'){if(!row.key){$('#unassigned-filter').value='1';}else $('#project-filter').value=row.key;}else{const from=row.group==='year'?row.key+'-01-01':row.group==='month'?row.key+'-01':row.key,to=row.group==='year'?row.key+'-12-31':row.group==='month'?new Date(Date.UTC(Number(row.key.slice(0,4)),Number(row.key.slice(5,7)),0)).toISOString().slice(0,10):row.key;$('#date-from-filter').value=range.from&&range.from>from?range.from:from;$('#date-to-filter').value=range.to&&range.to<to?range.to:to;}}
 showPage('receipts');render();$('.records-section').scrollIntoView({behavior:'smooth',block:'start'});
}
$('#spending-category').replaceChildren(...[...$('#category-filter').options].map(o=>new Option(o.text,o.value)));
for(const id of ['spending-period','spending-from','spending-to','dashboard-currency','spending-project','spending-category','spending-group'])$('#'+id).onchange=renderDashboard;
$('#dashboard-open').onclick=()=>showPage('overview');
$('#dashboard-receipts').onclick=()=>drillDashboard();

function resetFilters(){for(const [key,id] of Object.entries(filterIds))$('#'+id).value=key==='sort'?'newest':'';}
function persistFilters(f){
  const params=new URLSearchParams();for(const [key,value] of Object.entries(f))if(value&&key!=='projectExact'&&!(key==='sort'&&value==='newest')&&!(key==='status'&&value==='all'))params.set(key,value);
  const next=location.pathname+(params.size?'?'+params:'')+location.hash;if(next!==location.pathname+location.search+location.hash)history.replaceState(null,'',next);
}
function showPage(next,updateURL=true){
  page=next;$('#projects-page').hidden=next!=='projects';$('#projects-nav').classList.toggle('active',next==='projects');if(next==='projects'){$('#projects-page').append($('#projects-content'));loadProjects().then(paintProjects).catch(e=>notify(e.message));}
  $('#receipt-workspace').hidden=next!=='receipts';$('#dashboard').hidden=next!=='overview';$('#settings-page').hidden=next!=='settings';
  $('#daily-bot-link').hidden=next!=='receipts'||!botStatus?.paired;$('#export-open').hidden=['settings','projects'].includes(next);
  $('#dashboard-open').classList.toggle('active',next==='overview');$('#settings-open').classList.toggle('active',next==='settings');
  $('#receipts-open').classList.toggle('active',next==='receipts');
  document.querySelectorAll('.sidebar .nav-item').forEach(button=>{if(button.classList.contains('active'))button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
  syncReceiptTabs();
  $('#page-title').textContent=next==='projects'?'Projects':next==='overview'?'Expenses':next==='settings'?'Settings':'Receipts';
  $('#page-description').textContent=next==='projects'?'Group receipts by trip, client or job.':next==='overview'?'Totals by receipt date. Select a bar or row to open its receipts.':next==='settings'?'Manage your company, members and receipt storage.':'';
  if(updateURL)history.replaceState(null,'',location.pathname+location.search+(next==='receipts'?'':'#'+next));
  if(next==='overview')renderDashboard();if(next==='settings')refreshHealth();
  window.scrollTo({top:0,behavior:'instant'});
}
$('#settings-open').onclick=()=>showPage('settings');
const initialParams=new URLSearchParams(location.search);
for(const [key,id] of Object.entries(filterIds)){const value=initialParams.get(key);if(value!==null){const element=$('#'+id);if(key==='project'||key==='year'&&/^\d{4}$/.test(value))element.add(new Option(value,value));element.value=value;}}
if(['all','pending','processing','complete','trash'].includes(initialParams.get('status')))view=initialParams.get('status');
const route=()=>{const hash=location.hash;showPage(hash==='#projects'?'projects':hash==='#settings'?'settings':hash==='#overview'?'overview':'receipts',false);const match=hash.match(/^#receipt=([a-f0-9-]{36})$/);if(match)openReceipt(match[1]);};
window.addEventListener('hashchange',route);

$('#date-preset').onchange=()=>{
  const choice=$('#date-preset').value;$('#year-filter').value='';$('#month-filter').value='';$('#date-from-filter').value='';$('#date-to-filter').value='';
  if(choice==='undated')$('#year-filter').value='undated';
  else if(choice==='custom'){$('#filter-details').hidden=false;$('#more-filters').setAttribute('aria-expanded','true');}
  else if(choice){const range=calendarRange(choice);$('#date-from-filter').value=range.from;$('#date-to-filter').value=range.to;}
  render();
};

refresh();

api('/api/company').then(profile=>{$('#workspace-company').textContent=profile.name||'';}).catch(()=>{});

let projectItems=[];
function syncProjectOptions(){
 for(const [id,label] of [['project-filter','All projects'],['receipt-project','No project'],['export-project','All projects'],['spending-project','All projects']]){
  const select=$('#'+id),current=select.value,names=projectItems.map(p=>p.name);if(current&&!names.includes(current))names.push(current);
  select.replaceChildren(new Option(label,''),...names.map(name=>new Option(name,name)));select.value=current;
 }
}
async function loadProjects(){const result=await api('/api/projects');projectItems=result.items;syncProjectOptions();}
function paintProjects(){
 $('#project-list').innerHTML=projectItems.length?projectItems.map((p,i)=>`<article class="project-row"><button class="project-entry" data-project-view="${i}" type="button" ${$('#receipt-dialog').open?'disabled':''}><span><strong>${esc(p.name)}</strong><small>${p.count} receipt${p.count===1?'':'s'}</small></span><span class="project-total">${p.totals.length?p.totals.map(g=>`${esc(g.currency)} ${esc(g.total)}${g.unknownTotal?' (incomplete)':''}`).join('<br>'):'No expenses yet'}<small>View receipts →</small></span></button><details class="project-options"><summary>Manage</summary><form data-project-rename="${i}"><input aria-label="Project name" name="name" maxlength="200" required value="${esc(p.name)}" ${$('#receipt-dialog').open?'disabled':''}><button class="text-button" type="submit" ${$('#receipt-dialog').open?'disabled':''}>Rename</button></form>${p.canRemove?`<button class="text-button" data-project-remove="${i}" type="button">Remove empty project</button>`:''}</details></article>`).join(''):'<div class="empty-state"><h3>Keep each trip or job together.</h3><p>Create your first project above, then choose it in a receipt’s Project field.</p></div>';
 for(const form of document.querySelectorAll('[data-project-rename]'))form.onsubmit=async e=>{e.preventDefault();const from=projectItems[Number(form.dataset.projectRename)].name,name=form.elements.name.value.trim();if(!await changeProject('PATCH',{from,name}))return;if($('#project-filter').value===from)$('#project-filter').value=name;refresh();};
 for(const button of document.querySelectorAll('[data-project-view]'))button.onclick=()=>{const name=projectItems[Number(button.dataset.projectView)].name;if($('#receipt-dialog').open){notify('Close the receipt before viewing a project.');return;}resetFilters();view='all';$('#project-filter').value=name;$('#projects-dialog').close();showPage('receipts');refresh();};
 for(const button of document.querySelectorAll('[data-project-remove]'))button.onclick=()=>changeProject('DELETE',{name:projectItems[Number(button.dataset.projectRemove)].name});
}
async function changeProject(method,input){
 try{const result=await api('/api/projects',{method,body:JSON.stringify(input)});projectItems=result.items;syncProjectOptions();paintProjects();$('#projects-error').hidden=true;return true;}
 catch(e){$('#projects-error').textContent=e.message;$('#projects-error').hidden=false;return false;}
}
async function openProjects(){try{$('#projects-dialog').append($('#projects-content'));await loadProjects();paintProjects();$('#projects-error').hidden=true;$('#projects-dialog').showModal();}catch(e){notify(e.message);}}
$('#projects-nav').onclick=()=>showPage('projects');
$('#projects-dialog').addEventListener('close',()=>{if(page==='projects')$('#projects-page').append($('#projects-content'));});
$('#receipt-projects-open').onclick=openProjects;$('#projects-close').onclick=()=>$('#projects-dialog').close();
$('#project-create').onsubmit=async e=>{e.preventDefault();const name=$('#project-name').value.trim();if(await changeProject('POST',{name})){$('#project-name').value='';if($('#receipt-dialog').open){$('#receipt-project').value=name;$('#projects-dialog').close();}}};
loadProjects().catch(()=>{});

route();

async function loadMembers(){
 const data=await api('/api/members');
 $('#members-list').innerHTML=data.members.map(m=>`<div class="member-row"><span><b>${esc(m.name)}</b><small>${esc(({owner:'Owner',member:'Member'})[m.role]||m.role)} · Telegram ${esc(m.user)}</small></span>${m.role==='member'?`<button class="text-button" data-remove-member="${esc(m.user)}">Remove</button>`:''}</div>`).join('')||'<p>Connect and pair the receipt bot first.</p>';
 $('#member-invite').disabled=!data.members.length;
 $('#member-invitations').innerHTML=data.invites.length?'<h3>Pending invitations</h3>'+data.invites.map(i=>`<div class="member-row"><span>Expires ${esc(new Date(i.expires).toLocaleString())}</span><button class="text-button" data-revoke-invite="${i.id}">Revoke</button></div>`).join(''):'';
 for(const b of document.querySelectorAll('[data-remove-member]'))b.onclick=()=>memberAction('DELETE',{action:'remove',user:b.dataset.removeMember});
 for(const b of document.querySelectorAll('[data-revoke-invite]'))b.onclick=()=>memberAction('DELETE',{action:'revoke',id:b.dataset.revokeInvite});
}
async function memberAction(method,input){
 $('#members-error').hidden=true;$('#member-invite').disabled=true;
 try{const result=await api('/api/members',{method,body:JSON.stringify(input)});if(result.link){$('#member-link').value=result.link;$('#member-link-box').hidden=false;}else{$('#member-link-box').hidden=true;$('#member-link').value='';}await loadMembers();}
 catch(e){$('#members-error').textContent=e.message;$('#members-error').hidden=false;}finally{$('#member-invite').disabled=!botStatus?.paired;}
}
$('#members-open').onclick=async()=>{$('#members-error').hidden=true;$('#member-link-box').hidden=true;$('#members-dialog').showModal();try{await loadMembers();}catch(e){$('#members-list').textContent='';$('#member-invitations').textContent='';$('#member-invite').disabled=true;$('#members-error').textContent=e.message;$('#members-error').hidden=false;}};
$('#members-close').onclick=()=>$('#members-dialog').close();
$('#members-dialog').addEventListener('close',()=>{$('#member-link').value='';refreshBot();});
$('#member-invite').onclick=()=>memberAction('POST',{action:'invite'});
$('#member-copy').onclick=async()=>{try{await navigator.clipboard.writeText($('#member-link').value);notify('Invitation link copied.');}catch{$('#member-link').select();notify('Select and copy the invitation link.');}};

$('#project-filter').addEventListener('change',()=>{$('#unassigned-filter').value='';render();});

document.querySelector('.skip-link').onclick=event=>{event.preventDefault();$('#main-content').focus();$('#main-content').scrollIntoView({block:'start'});};

$('#preview-dialog').addEventListener('keydown',event=>{if(event.target.matches('select')||previewPages<=1)return;const button=event.key==='ArrowRight'?$('#preview-next'):event.key==='ArrowLeft'?$('#preview-prev'):null;if(button&&!button.disabled){event.preventDefault();button.click();}});
