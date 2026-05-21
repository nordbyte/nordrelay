function uiBadge(text,status='enabled'){return '<span class="adapter-status '+esc(status)+'">'+esc(text)+'</span>'}
function uiRows(rows:WebuiRows=[]){return rows.filter(Boolean).map(row=>Array.isArray(row)?'<small>'+esc(row[0])+': '+esc(row[1]??'-')+'</small>':'<small>'+esc(row)+'</small>').join('')}
function uiItem(title,options:UiItemOptions={}){const badge=options.badge?uiBadge(options.badge.text,options.badge.status):'';const rows=uiRows(options.rows||[]);const body=options.body||'';const actions=options.actions?uiActions(options.actions):'';const titleAttr=options.title?(' title="'+attr(options.title)+'"'):'';const titleBody=options.titleHtml||esc(title);return '<div class="item '+(options.className?attr(options.className):'')+'"><strong'+titleAttr+'>'+titleBody+' '+badge+'</strong>'+rows+body+actions+'</div>'}
function uiCard(title,rows:WebuiRows=[],options:UiCardOptions={}){return uiItem(title,{...options,rows})}
function uiEmpty(text){return '<div class="item empty-state">'+esc(text)+'</div>'}
function uiList(items,emptyText){return (items||[]).join('')||uiEmpty(emptyText)}
function uiCopyButton(value,label='Copied',className='copy-id'){return value?'<button type="button" class="'+attr(className)+'" data-copy-value="'+attr(value)+'" data-copy-label="'+attr(label)+'">'+esc(value)+'</button>':'-'}
function uiButton(label,options:UiButtonOptions={}){const classes=[options.variant==='danger'?'danger':options.variant==='secondary'?'secondary':'',options.mini?'mini-button':'',options.className||''].filter(Boolean).join(' ');const data=Object.entries(options.data||{}).map(([key,value])=>' data-'+key.replace(/[A-Z]/g,m=>'-'+m.toLowerCase())+'="'+attr(value)+'"').join('');const disabled=options.disabled?' disabled':'';const title=options.title?' title="'+attr(options.title)+'"':'';return '<button type="button"'+(classes?' class="'+attr(classes)+'"':'')+data+disabled+title+'>'+esc(label)+'</button>'}
function uiActions(actions){return '<div class="row ui-actions">'+(Array.isArray(actions)?actions.join(''):actions)+'</div>'}
function uiTraceControls(correlationId){return correlationId?'CID: '+uiCopyButton(correlationId,'Correlation ID copied')+' '+uiButton('Trace',{variant:'secondary',mini:true,data:{traceId:correlationId}}):''}
function uiToolbar(items,className='toolbar'){return '<div class="'+attr(className)+'">'+(Array.isArray(items)?items.join(''):items)+'</div>'}
function scheduleIncrementalRender(callback){if(typeof requestIdleCallback==='function')return requestIdleCallback(()=>callback(),{timeout:80});return setTimeout(callback,0)}
function cancelIncrementalRender(key){const active=state.incrementalRenders?.[key];if(active)active.cancelled=true}
function renderIncrementalTable<T>(target:string|Element,items:readonly T[],options:RenderIncrementalOptions<T>){
  const el=typeof target==='string'?document.getElementById(target):target;
  const sourceRows=Array.isArray(items)?items:[];
  const maxRenderRows=Number(options.maxRenderRows||1000);
  const rows=maxRenderRows>0?sourceRows.slice(0,maxRenderRows):sourceRows;
  if(!el)return;
  const key=options.key||el.id||'table';
  cancelIncrementalRender(key);
  const token={cancelled:false};
  state.incrementalRenders[key]=token;
  if(!rows.length){el.innerHTML=options.emptyHtml||uiEmpty(options.emptyText||'No entries.');options.onDone?.(el);return}
  const wrapClass=['data-table-wrap',options.wrapClass||''].filter(Boolean).join(' ');
  const tableClass=['data-table',options.tableClass||''].filter(Boolean).join(' ');
  const tableClassHtml=options.tableClassHtml||('class="'+attr(tableClass)+'"');
  const cappedNotice=rows.length<sourceRows.length?'<small class="incremental-render-status capped" aria-live="polite">Showing '+rows.length+' of '+sourceRows.length+' rows. Use pagination or filters to load the rest.</small>':'';
  el.innerHTML='<div class="'+attr(wrapClass)+'"><table '+tableClassHtml+'><thead>'+options.headHtml+'</thead><tbody></tbody></table></div>'+cappedNotice+'<small class="incremental-render-status" aria-live="polite"></small>';
  const tbody=el.querySelector('tbody');
  const status=el.querySelector('.incremental-render-status');
  renderIncrementalRows(tbody,status,rows,options,token,el);
}
function renderIncrementalHtml<T>(target:string|Element,items:readonly T[],options:RenderIncrementalOptions<T>){
  const el=typeof target==='string'?document.getElementById(target):target;
  const sourceRows=Array.isArray(items)?items:[];
  const maxRenderRows=Number(options.maxRenderRows||1000);
  const rows=maxRenderRows>0?sourceRows.slice(0,maxRenderRows):sourceRows;
  if(!el)return;
  const key=options.key||el.id||'list';
  cancelIncrementalRender(key);
  const token={cancelled:false};
  state.incrementalRenders[key]=token;
  if(!rows.length){el.innerHTML=options.emptyHtml||uiEmpty(options.emptyText||'No entries.');options.onDone?.(el);return}
  const bodyTag=options.bodyTag||'div';
  const cappedNotice=rows.length<sourceRows.length?'<small class="incremental-render-status capped" aria-live="polite">Showing '+rows.length+' of '+sourceRows.length+' rows. Use pagination or filters to load the rest.</small>':'';
  el.innerHTML=(options.prefixHtml||'')+'<'+bodyTag+' data-incremental-body></'+bodyTag+'>'+(options.suffixHtml||'')+cappedNotice+'<small class="incremental-render-status" aria-live="polite"></small>';
  const body=el.querySelector('[data-incremental-body]');
  const status=el.querySelector('.incremental-render-status');
  renderIncrementalRows(body,status,rows,options,token,el);
}
function renderIncrementalRows(body,status,rows,options,token,root){
  let index=0;
  const batchSize=Math.max(1,Math.min(250,Number(options.batchSize||75)));
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
function bindUiCopyButtons(root:Element|Document=document){root.querySelectorAll?.<HTMLElement>('[data-copy-value],[data-copy-id]').forEach(b=>b.onclick=()=>copyText(b.dataset.copyValue||b.dataset.copyId||'',b.dataset.copyLabel||'Copied'))}
function bindUiTraceButtons(root:Element|Document=document){root.querySelectorAll?.<HTMLElement>('[data-trace-id]').forEach(b=>b.onclick=()=>openTrace(b.dataset.traceId||''))}
