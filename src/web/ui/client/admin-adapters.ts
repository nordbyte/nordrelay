function switchAdapterTab(tab){state.adapterTab=tab||'adapters';document.querySelectorAll('[data-adapter-tab]').forEach(b=>{const active=b.dataset.adapterTab===state.adapterTab;b.classList.toggle('active',active);b.setAttribute('aria-selected',active?'true':'false');b.tabIndex=active?0:-1});document.querySelectorAll('[data-adapter-tab-panel]').forEach(panel=>panel.classList.toggle('active',panel.dataset.adapterTabPanel===state.adapterTab))}
function bindAdapterTabs(){document.querySelectorAll('[data-adapter-tab]').forEach(b=>b.onclick=()=>switchAdapterTab(b.dataset.adapterTab))}
bindAdapterTabs();
switchAdapterTab(state.adapterTab||'adapters');
function adapterCell(label,html,cls=''){return '<td data-label="'+attr(label)+'"'+(cls?' class="'+cls+'"':'')+'>'+html+'</td>'}
function adapterAuthText(a){if(!a.auth?.supported)return'not managed';const status=a.auth.authenticated===null?'unknown':(a.auth.authenticated?'authenticated':'not authenticated');return[status,a.auth.detail||''].filter(Boolean).join(' | ')}
function adapterVersionText(a){const installed=a.version?.installed||'-';const latest=a.version?.latest||'-';const status=a.version?.status||'-';return installed+' / latest '+latest+' / '+status}
function renderAdapterHealthRow(a){const status='<span class="adapter-status '+esc(a.status)+'">'+esc(a.status)+'</span>';const cliPath=a.cli?.path||a.cli?.label||'-';const actions='<div class="data-table-actions"><button data-auth-status="'+attr(a.id)+'">Auth status</button><button data-auth-login="'+attr(a.id)+'" class="secondary" '+(!a.capabilities.login?'disabled':'')+disabledAttr('auth.manage')+'>Login</button><button data-auth-logout="'+attr(a.id)+'" class="secondary" '+(!a.capabilities.logout?'disabled':'')+disabledAttr('auth.manage')+'>Logout</button></div>';return '<tr>'+adapterCell('Adapter','<span class="truncate-cell" title="'+attr(a.label)+'">'+esc(a.label)+'</span>','primary-cell')+adapterCell('Status',status,'status-cell')+adapterCell('CLI Path','<span class="truncate-cell" title="'+attr(cliPath)+'">'+esc(short(cliPath,180))+'</span>','path-cell')+adapterCell('CLI Version','<span class="truncate-cell" title="'+attr(a.cli?.version||'')+'">'+esc(short(a.cli?.version||'-',80))+'</span>','version-cell')+adapterCell('Auth','<span class="truncate-cell" title="'+attr(adapterAuthText(a))+'">'+esc(short(adapterAuthText(a),120))+'</span>','auth-cell')+adapterCell('Version','<span class="truncate-cell" title="'+attr(adapterVersionText(a))+'">'+esc(short(adapterVersionText(a),140))+'</span>','version-cell')+adapterCell('Actions',actions,'actions-cell')+'</tr>'}
function renderAdapterHealthTable(adapters){if(!adapters.length)return '<div class="item">No adapters.</div>';return '<div class="data-table-wrap"><table class="data-table adapters-table"><thead><tr><th>Adapter</th><th>Status</th><th>CLI Path</th><th>CLI Version</th><th>Auth</th><th>Version</th><th class="actions-heading">Actions</th></tr></thead><tbody>'+adapters.map(renderAdapterHealthRow).join('')+'</tbody></table></div>'}
async function loadAdapterHealth(){
  setLoading('adapterHealth','Loading adapters...');
  setLoading('adapterConformance','Loading conformance...');
  const [d, conformance]=await Promise.all([api('/api/adapters/health'),api('/api/adapters/conformance')]);
  state.adapterConformance=conformance;
  document.getElementById('adapterHealth').innerHTML=renderAdapterHealthTable(d.adapters||[]);
  renderAdapterConformance(conformance);
  document.querySelectorAll('[data-auth-status]').forEach(b=>b.onclick=()=>safe(async()=>{const r=await api('/api/auth/status',{query:{agent:b.dataset.authStatus}});toast(r.agentLabel+': '+r.detail,{duration:6000})}));
  document.querySelectorAll('[data-auth-login]').forEach(b=>b.onclick=()=>safe(async()=>{if(!can('auth.manage')){toast('Permission required: auth.manage');return}const r=await api('/api/auth/login',{method:'POST',body:{agentId:b.dataset.authLogin}});toast((r.result?.message||r.detail),{duration:8000});loadAdapterHealth()}));
  document.querySelectorAll('[data-auth-logout]').forEach(b=>b.onclick=()=>safe(async()=>{if(!can('auth.manage')){toast('Permission required: auth.manage');return}const r=await api('/api/auth/logout',{method:'POST',body:{agentId:b.dataset.authLogout}});toast((r.result?.message||r.detail),{duration:8000});loadAdapterHealth()}));
  applyPermissions();
}
function renderAdapterConformance(matrix){
  const target=document.getElementById('adapterConformance');
  if(!target)return;
  const agents=(matrix?.agents||[]).map(a=>conformanceCard(a,'agent')).join('');
  const channels=(matrix?.channels||[]).map(c=>conformanceCard(c,'channel')).join('');
  target.innerHTML='<div class="conformance-grid"><div><h3>Agent capability contract</h3>'+(agents||'<div class="item">No agent conformance rows.</div>')+'</div><div><h3>Channel command contract</h3>'+(channels||'<div class="item">No channel conformance rows.</div>')+'</div></div>';
}
function conformanceCard(item,kind){
  const missing=(item.unsupported||[]).length;
  const coverage=item.commandCoverage||{};
  const commandMissing=(coverage.missing||[]).length;
  const actionMissing=(item.actionUnsupported||[]).length;
  const commands=kind==='channel'&&item.commands?'<small>'+esc('Commands: '+item.commands.length+(commandMissing?' / '+commandMissing+' missing':'')+(item.commands.length?' / '+short(item.commands.join(', '),180):''))+'</small>':'';
  const actions=kind==='channel'&&item.actions?'<small>'+esc('Runtime actions: '+(item.actionSupported||[]).length+' supported'+(actionMissing?' / '+actionMissing+' limited':''))+'</small>'+conformanceFeatureMatrix(item.actions||[]):'';
  const badge=missing===0?'enabled':(item.status==='planned'?'disabled':'planned');
  return '<div class="item"><strong>'+esc(item.label)+' <span class="adapter-status '+badge+'">'+esc(missing===0?'complete':missing+' missing')+'</span></strong><small>'+esc('Status: '+item.status+(item.enabled===undefined?'':' / '+(item.enabled?'enabled':'disabled')))+'</small>'+commands+conformanceFeatureMatrix(item.features||[])+actions+'</div>';
}
function conformanceFeatureMatrix(features){
  return '<div class="feature-matrix">'+(features||[]).map(f=>'<span class="feature-chip '+(f.supported?'supported':'unsupported')+'" title="'+attr(f.description||f.key)+'"><span>'+esc(f.label||f.key)+'</span><b>'+(f.supported?'✓':'-')+'</b></span>').join('')+'</div>';
}
document.getElementById('reloadAdaptersBtn').onclick=()=>loadAdapterHealth();
document.getElementById('reloadAdapterConformanceBtn').onclick=()=>loadAdapterHealth();
