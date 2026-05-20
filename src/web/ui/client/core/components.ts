function uiBadge(text,status='enabled'){return '<span class="adapter-status '+esc(status)+'">'+esc(text)+'</span>'}
function uiRows(rows=[]){return rows.filter(Boolean).map(row=>Array.isArray(row)?'<small>'+esc(row[0])+': '+esc(row[1]??'-')+'</small>':'<small>'+esc(row)+'</small>').join('')}
function uiItem(title,options:any={}){const badge=options.badge?uiBadge(options.badge.text,options.badge.status):'';const rows=uiRows(options.rows||[]);const body=options.body||'';const actions=options.actions?uiActions(options.actions):'';const titleAttr=options.title?(' title="'+attr(options.title)+'"'):'';const titleBody=options.titleHtml||esc(title);return '<div class="item '+(options.className?attr(options.className):'')+'"><strong'+titleAttr+'>'+titleBody+' '+badge+'</strong>'+rows+body+actions+'</div>'}
function uiCard(title,rows=[],options:any={}){return uiItem(title,{...options,rows})}
function uiEmpty(text){return '<div class="item empty-state">'+esc(text)+'</div>'}
function uiList(items,emptyText){return (items||[]).join('')||uiEmpty(emptyText)}
function uiCopyButton(value,label='Copied',className='copy-id'){return value?'<button type="button" class="'+attr(className)+'" data-copy-value="'+attr(value)+'" data-copy-label="'+attr(label)+'">'+esc(value)+'</button>':'-'}
function uiButton(label,options:any={}){const classes=[options.variant==='danger'?'danger':options.variant==='secondary'?'secondary':'',options.mini?'mini-button':'',options.className||''].filter(Boolean).join(' ');const data=Object.entries(options.data||{}).map(([key,value])=>' data-'+key.replace(/[A-Z]/g,m=>'-'+m.toLowerCase())+'="'+attr(value)+'"').join('');const disabled=options.disabled?' disabled':'';const title=options.title?' title="'+attr(options.title)+'"':'';return '<button type="button"'+(classes?' class="'+attr(classes)+'"':'')+data+disabled+title+'>'+esc(label)+'</button>'}
function uiActions(actions){return '<div class="row ui-actions">'+(Array.isArray(actions)?actions.join(''):actions)+'</div>'}
function uiTraceControls(correlationId){return correlationId?'CID: '+uiCopyButton(correlationId,'Correlation ID copied')+' '+uiButton('Trace',{variant:'secondary',mini:true,data:{traceId:correlationId}}):''}
function uiToolbar(items,className='toolbar'){return '<div class="'+attr(className)+'">'+(Array.isArray(items)?items.join(''):items)+'</div>'}
function scheduleIncrementalRender(callback){if(typeof requestIdleCallback==='function')return requestIdleCallback(()=>callback(),{timeout:80});return setTimeout(callback,0)}
function cancelIncrementalRender(key){const active=state.incrementalRenders?.[key];if(active)active.cancelled=true}
function renderIncrementalTable(target,items,options:any={}){
  const el=typeof target==='string'?document.getElementById(target):target;
  const rows=Array.isArray(items)?items:[];
  if(!el)return;
  const key=options.key||el.id||'table';
  cancelIncrementalRender(key);
  const token={cancelled:false};
  state.incrementalRenders[key]=token;
  if(!rows.length){el.innerHTML=options.emptyHtml||uiEmpty(options.emptyText||'No entries.');options.onDone?.(el);return}
  const wrapClass=['data-table-wrap',options.wrapClass||''].filter(Boolean).join(' ');
  const tableClass=['data-table',options.tableClass||''].filter(Boolean).join(' ');
  const tableClassHtml=options.tableClassHtml||('class="'+attr(tableClass)+'"');
  el.innerHTML='<div class="'+attr(wrapClass)+'"><table '+tableClassHtml+'><thead>'+options.headHtml+'</thead><tbody></tbody></table></div><small class="incremental-render-status" aria-live="polite"></small>';
  const tbody=el.querySelector('tbody');
  const status=el.querySelector('.incremental-render-status');
  renderIncrementalRows(tbody,status,rows,options,token,el);
}
function renderIncrementalHtml(target,items,options:any={}){
  const el=typeof target==='string'?document.getElementById(target):target;
  const rows=Array.isArray(items)?items:[];
  if(!el)return;
  const key=options.key||el.id||'list';
  cancelIncrementalRender(key);
  const token={cancelled:false};
  state.incrementalRenders[key]=token;
  if(!rows.length){el.innerHTML=options.emptyHtml||uiEmpty(options.emptyText||'No entries.');options.onDone?.(el);return}
  const bodyTag=options.bodyTag||'div';
  el.innerHTML=(options.prefixHtml||'')+'<'+bodyTag+' data-incremental-body></'+bodyTag+'>'+(options.suffixHtml||'')+'<small class="incremental-render-status" aria-live="polite"></small>';
  const body=el.querySelector('[data-incremental-body]');
  const status=el.querySelector('.incremental-render-status');
  renderIncrementalRows(body,status,rows,options,token,el);
}
function renderIncrementalRows(body,status,rows,options,token,root){
  let index=0;
  const batchSize=Math.max(1,Number(options.batchSize||75));
  const initialCount=Math.max(1,Number(options.initialCount||batchSize));
  const appendChunk=(count)=>{
    if(token.cancelled||!body)return;
    const end=Math.min(rows.length,index+count);
    let html='';
    for(;index<end;index++)html+=options.renderItem(rows[index],index);
    if(html)body.insertAdjacentHTML('beforeend',html);
    if(status)status.textContent=index<rows.length?'Rendering '+index+' / '+rows.length+'...':'';
    options.onBatch?.(root,index,rows.length);
    if(index<rows.length)scheduleIncrementalRender(()=>appendChunk(batchSize));
    else{if(status)status.remove();options.onDone?.(root)}
  };
  appendChunk(initialCount);
}
/** @param {any} [root] */
function bindUiCopyButtons(root){root=root||document;root.querySelectorAll?.('[data-copy-value],[data-copy-id]').forEach(b=>b.onclick=()=>copyText(b.dataset.copyValue||b.dataset.copyId||'',b.dataset.copyLabel||'Copied'))}
/** @param {any} [root] */
function bindUiTraceButtons(root){root=root||document;root.querySelectorAll?.('[data-trace-id]').forEach(b=>b.onclick=()=>openTrace(b.dataset.traceId||''))}
