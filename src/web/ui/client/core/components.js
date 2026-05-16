function uiBadge(text,status='enabled'){return '<span class="adapter-status '+esc(status)+'">'+esc(text)+'</span>'}
function uiRows(rows=[]){return rows.filter(Boolean).map(row=>Array.isArray(row)?'<small>'+esc(row[0])+': '+esc(row[1]??'-')+'</small>':'<small>'+esc(row)+'</small>').join('')}
function uiItem(title,options={}){const badge=options.badge?uiBadge(options.badge.text,options.badge.status):'';const rows=uiRows(options.rows||[]);const body=options.body||'';const actions=options.actions?'<div class="row">'+options.actions+'</div>':'';const titleAttr=options.title?(' title="'+attr(options.title)+'"'):'';return '<div class="item '+(options.className?attr(options.className):'')+'"><strong'+titleAttr+'>'+esc(title)+' '+badge+'</strong>'+rows+body+actions+'</div>'}
function uiCard(title,rows=[],options={}){return uiItem(title,{...options,rows})}
function uiEmpty(text){return '<div class="item">'+esc(text)+'</div>'}
function uiList(items,emptyText){return (items||[]).join('')||uiEmpty(emptyText)}
function uiCopyButton(value,label='Copied',className='copy-id'){return value?'<button type="button" class="'+attr(className)+'" data-copy-value="'+attr(value)+'" data-copy-label="'+attr(label)+'">'+esc(value)+'</button>':'-'}
function bindUiCopyButtons(root=document){root.querySelectorAll?.('[data-copy-value]').forEach(b=>b.onclick=()=>copyText(b.dataset.copyValue||'',b.dataset.copyLabel||'Copied'))}
