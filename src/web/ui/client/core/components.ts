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
let tableActionMenuListenersBound=false;
function tableActionMenuHtml(buttons,options:TableActionMenuOptions={}){
  const items=Array.isArray(buttons)?buttons.join(''):String(buttons||'');
  const classes=['table-action-menu','table-action-menu-panel-menu',options.className||''].filter(Boolean).join(' ');
  const listClasses=['table-action-menu-list','table-action-menu-panel',options.panelClassName||''].filter(Boolean).join(' ');
  const id=options.id!==undefined&&options.id!==null?String(options.id):'';
  const data=id?' data-table-action-menu="'+attr(id)+'"':'';
  const extra=options.attrs?' '+String(options.attrs).trim():'';
  return '<details class="'+attr(classes)+'"'+data+extra+'><summary>More</summary><div class="'+attr(listClasses)+'">'+items+'</div></details>';
}
function tableActionMenuId(menu:HTMLDetailsElement|null){return menu?.dataset.tableActionMenu||menu?.dataset.peerActionMenu||''}
function currentOpenTableActionMenuId(selector='.table-action-menu'){return tableActionMenuId(document.querySelector<HTMLDetailsElement>(selector+'[open]'))}
function resetTableActionMenu(menu:HTMLDetailsElement){const list=menu.querySelector<HTMLElement>('.table-action-menu-list');menu.classList.remove('is-floating');if(list){list.style.left='';list.style.top='';list.style.right='';list.style.visibility=''}}
function closeTableActionMenus(except?:HTMLDetailsElement){document.querySelectorAll<HTMLDetailsElement>('.table-action-menu[open]').forEach(menu=>{if(menu===except)return;menu.open=false;resetTableActionMenu(menu)})}
function positionTableActionMenu(menu:HTMLDetailsElement){const summary=menu.querySelector<HTMLElement>('summary');const list=menu.querySelector<HTMLElement>('.table-action-menu-list');if(!menu.open||!summary||!list)return;const margin=8;const panel=list.classList.contains('table-action-menu-panel');const gap=panel?8:6;menu.classList.add('is-floating');list.style.visibility='hidden';list.style.left='0px';list.style.top='0px';list.style.right='auto';const buttonRect=summary.getBoundingClientRect();const listRect=list.getBoundingClientRect();const width=Math.max(listRect.width,panel?220:150);const height=listRect.height;const maxLeft=Math.max(margin,window.innerWidth-width-margin);let left=Math.min(Math.max(margin,buttonRect.right-width),maxLeft);let top=buttonRect.bottom+gap;if(top+height>window.innerHeight-margin&&buttonRect.top-height-gap>margin)top=buttonRect.top-height-gap;else top=Math.min(top,Math.max(margin,window.innerHeight-height-margin));list.style.left=Math.round(left)+'px';list.style.top=Math.round(Math.max(margin,top))+'px';list.style.visibility=''}
function positionOpenTableActionMenus(){document.querySelectorAll<HTMLDetailsElement>('.table-action-menu[open]').forEach(menu=>positionTableActionMenu(menu))}
function restoreTableActionMenu(menuId,selector){if(!menuId)return;const query=selector||'.table-action-menu[data-table-action-menu="'+cssEscape(String(menuId))+'"]';const menu=document.querySelector<HTMLDetailsElement>(query);if(!menu)return;menu.open=true;positionTableActionMenu(menu);requestAnimationFrame(()=>positionTableActionMenu(menu))}
function bindTableActionMenus(root:Document|Element=document){root.querySelectorAll<HTMLDetailsElement>('.table-action-menu').forEach(menu=>{if(menu.dataset.floatingBound)return;menu.dataset.floatingBound='true';menu.addEventListener('toggle',()=>{if(menu.open){closeTableActionMenus(menu);positionTableActionMenu(menu)}else resetTableActionMenu(menu)});menu.addEventListener('click',event=>{const target=event.target instanceof Element?event.target:null;if(target?.closest('button'))setTimeout(()=>{menu.open=false;resetTableActionMenu(menu)},0)})});if(tableActionMenuListenersBound)return;tableActionMenuListenersBound=true;document.addEventListener('click',event=>{const target=event.target instanceof Element?event.target:null;if(target?.closest('.table-action-menu'))return;closeTableActionMenus()});document.addEventListener('keydown',event=>{if(event.key==='Escape')closeTableActionMenus()});window.addEventListener('resize',positionOpenTableActionMenus);window.addEventListener('scroll',positionOpenTableActionMenus,true)}
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
