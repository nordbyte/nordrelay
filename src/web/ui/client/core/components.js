function uiBadge(text,status='enabled'){return '<span class="adapter-status '+esc(status)+'">'+esc(text)+'</span>'}
function uiRows(rows=[]){return rows.filter(Boolean).map(row=>Array.isArray(row)?'<small>'+esc(row[0])+': '+esc(row[1]??'-')+'</small>':'<small>'+esc(row)+'</small>').join('')}
function uiItem(title,options={}){const badge=options.badge?uiBadge(options.badge.text,options.badge.status):'';const rows=uiRows(options.rows||[]);const body=options.body||'';const actions=options.actions?uiActions(options.actions):'';const titleAttr=options.title?(' title="'+attr(options.title)+'"'):'';const titleBody=options.titleHtml||esc(title);return '<div class="item '+(options.className?attr(options.className):'')+'"><strong'+titleAttr+'>'+titleBody+' '+badge+'</strong>'+rows+body+actions+'</div>'}
function uiCard(title,rows=[],options={}){return uiItem(title,{...options,rows})}
function uiEmpty(text){return '<div class="item empty-state">'+esc(text)+'</div>'}
function uiList(items,emptyText){return (items||[]).join('')||uiEmpty(emptyText)}
function uiCopyButton(value,label='Copied',className='copy-id'){return value?'<button type="button" class="'+attr(className)+'" data-copy-value="'+attr(value)+'" data-copy-label="'+attr(label)+'">'+esc(value)+'</button>':'-'}
function uiButton(label,options={}){const classes=[options.variant==='danger'?'danger':options.variant==='secondary'?'secondary':'',options.mini?'mini-button':'',options.className||''].filter(Boolean).join(' ');const data=Object.entries(options.data||{}).map(([key,value])=>' data-'+key.replace(/[A-Z]/g,m=>'-'+m.toLowerCase())+'="'+attr(value)+'"').join('');const disabled=options.disabled?' disabled':'';const title=options.title?' title="'+attr(options.title)+'"':'';return '<button type="button"'+(classes?' class="'+attr(classes)+'"':'')+data+disabled+title+'>'+esc(label)+'</button>'}
function uiActions(actions){return '<div class="row ui-actions">'+(Array.isArray(actions)?actions.join(''):actions)+'</div>'}
function uiTraceControls(correlationId){return correlationId?'CID: '+uiCopyButton(correlationId,'Correlation ID copied')+' '+uiButton('Trace',{variant:'secondary',mini:true,data:{traceId:correlationId}}):''}
function uiToolbar(items,className='toolbar'){return '<div class="'+attr(className)+'">'+(Array.isArray(items)?items.join(''):items)+'</div>'}
/** @param {any} [root] */
function bindUiCopyButtons(root){root=root||document;root.querySelectorAll?.('[data-copy-value],[data-copy-id]').forEach(b=>b.onclick=()=>copyText(b.dataset.copyValue||b.dataset.copyId||'',b.dataset.copyLabel||'Copied'))}
/** @param {any} [root] */
function bindUiTraceButtons(root){root=root||document;root.querySelectorAll?.('[data-trace-id]').forEach(b=>b.onclick=()=>openTrace(b.dataset.traceId||''))}
