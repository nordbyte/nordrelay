async function loadPlugins(){
  bindPluginTabs();
  switchPluginTab(state.pluginTab||'installed');
  if(!can('plugins.read')){
    document.getElementById('pluginList').innerHTML=uiEmpty('Permission required: plugins.read');
    renderPluginPanelNav();
    return;
  }
  if(!state.peers&&can('peers.read')){
    state.peers=await api('/api/peers',{local:true}).catch(()=>state.peers);
  }
  setLoading('pluginList','Loading plugins...');
  setLoading('pluginMarketplace','Loading marketplace...');
  setLoading('pluginCatalog','Loading plugin catalog...');
  const [response]=await Promise.all([refreshPluginState({force:true}),refreshPluginMarketplace()]);
  const target=headerTargetName(state.selectedPeer||'local');
  document.getElementById('pluginStatus').innerHTML=response.enabled?'Plugins are enabled on '+esc(target)+'. Remote peers need their own installed and enabled plugins.':'Plugins are disabled on '+esc(target)+' by NORDRELAY_PLUGINS_ENABLED=false.';
  renderPlugins();
}
async function refreshPluginState(options:WebuiRecord={}){
  if(!can('plugins.read'))return{enabled:false,plugins:[],catalog:{}};
  const peerId=state.selectedPeer||'local';
  if(!options.force&&state.pluginCatalog&&state.pluginPanelNavPeer===peerId&&Date.now()-Number(state.pluginPanelNavLoadedAt||0)<30000){
    renderPluginPanelNav();
    return{enabled:true,plugins:state.plugins||[],catalog:state.pluginCatalog||{}};
  }
  const data=await api('/api/plugins');
  const response=Array.isArray(data.plugins)?data:{enabled:true,plugins:[],catalog:{}};
  state.plugins=response.plugins||[];
  state.pluginCatalog=response.catalog||{};
  state.pluginUpdateChecks=state.pluginUpdateChecks||{};
  state.pluginPanelNavLoadedAt=Date.now();
  state.pluginPanelNavPeer=peerId;
  renderPluginPanelNav();
  return response;
}
async function loadPluginPanelNav(){await refreshPluginState()}
async function refreshPluginMarketplace(options:WebuiRecord={}){
  if(!can('plugins.read'))return{entries:[]};
  const response=await api('/api/plugins/marketplace',{local:true,query:options.force?{force:true}:undefined});
  state.pluginMarketplace=response;
  return response;
}
function switchPluginTab(tab){
  state.pluginTab=tab||'installed';
  document.querySelectorAll('[data-plugin-tab]').forEach(b=>{const active=b.dataset.pluginTab===state.pluginTab;b.classList.toggle('active',active);b.setAttribute('aria-selected',active?'true':'false');b.tabIndex=active?0:-1});
  document.querySelectorAll('[data-plugin-tab-panel]').forEach(panel=>panel.classList.toggle('active',panel.dataset.pluginTabPanel===state.pluginTab));
}
function bindPluginTabs(){
  document.querySelectorAll('[data-plugin-tab]').forEach(b=>{if(b.dataset.bound)return;b.dataset.bound='true';b.onclick=()=>switchPluginTab(b.dataset.pluginTab)});
}
function renderPlugins(){
  renderPluginList();
  renderPluginMarketplace();
  renderPluginCatalog();
  renderPluginLogSelect();
  renderPluginPanelNav();
  bindPluginButtons();
  applyPermissions();
}
function enabledPluginPanels(){
  const enabledPlugins=new Set((state.plugins||[]).filter(plugin=>plugin.enabled!==false).map(plugin=>plugin.id));
  const panels=Array.isArray(state.pluginCatalog?.webPanels)?state.pluginCatalog.webPanels:[];
  return panels.filter(panel=>panel.pluginId&&panel.panelId&&enabledPlugins.has(panel.pluginId));
}
function pluginById(pluginId){return(state.plugins||[]).find(plugin=>plugin.id===pluginId)||null}
function pluginPanelKey(pluginId,panelId){return String(pluginId||'')+'::'+String(panelId||'')}
function pluginPanelTitle(panel){
  const plugin=pluginById(panel.pluginId);
  const title=panel.title||panel.panelId;
  const pluginName=plugin?.name||panel.pluginId;
  const count=enabledPluginPanels().filter(item=>item.pluginId===panel.pluginId).length;
  return count>1?pluginName+': '+title:pluginName;
}
function pluginPanelPageTitle(){
  const selected=state.pluginPanelPage;
  if(!selected)return'Plugin Panel';
  const panel=findPluginCapability(selected.pluginId,'web-panel',selected.panelId);
  return panel?pluginPanelTitle(panel):(selected.title||'Plugin Panel');
}
function renderPluginPanelNav(){
  const target=document.getElementById('pluginPanelNavItems');
  if(!target)return;
  if(!can('plugins.read')){target.innerHTML='';syncNavSections();return}
  const selected=state.pluginPanelPage;
  const panels=enabledPluginPanels();
  target.innerHTML=panels.map(panel=>{
    const key=pluginPanelKey(panel.pluginId,panel.panelId);
    const active=state.currentPage==='plugin-panel'&&selected&&pluginPanelKey(selected.pluginId,selected.panelId)===key;
    return '<button type="button" class="plugin-panel-nav-button '+(active?'active':'')+'" data-plugin-panel-nav="'+attr(key)+'" data-plugin-id="'+attr(panel.pluginId)+'" data-panel-id="'+attr(panel.panelId)+'" data-permission="plugins.read" title="'+attr(panel.title||panel.panelId)+'"><span class="nav-label">'+esc(pluginPanelTitle(panel))+'</span></button>';
  }).join('');
  bindPluginPanelNav();
  syncNavSections();
  applyPermissions();
}
function bindPluginPanelNav(){
  document.querySelectorAll('[data-plugin-panel-nav]').forEach(button=>{
    if(button.dataset.bound)return;
    button.dataset.bound='true';
    button.onclick=()=>selectPluginPanelPage(button.dataset.pluginId,button.dataset.panelId);
  });
}
function selectPluginPanelPage(pluginId,panelId){
  const panel=findPluginCapability(pluginId,'web-panel',panelId);
  const next={pluginId,panelId,title:panel?pluginPanelTitle(panel):panelId};
  state.pluginPanelPage=next;
  writeStoredPluginPanelPage(next);
  renderPluginPanelNav();
  page('plugin-panel');
}
function renderPluginList(){
  const plugins=state.plugins||[];
  const target=document.getElementById('pluginList');
  if(!target)return;
  if(!plugins.length){target.innerHTML=uiEmpty('No plugins installed.');return}
  renderIncrementalTable(target,plugins,{
    key:'plugins',
    emptyText:'No plugins installed.',
    headHtml:'<tr><th>Status</th><th>Plugin</th><th>Version</th><th>Runtime</th><th>Source</th><th>Permissions</th><th>Capabilities</th><th class="actions-heading">Actions</th></tr>',
    renderItem:plugin=>pluginRow(plugin),
    initialCount:30,
    batchSize:60,
    onDone:root=>{bindPluginButtons(root);applyPermissions()},
  });
}
function pluginRow(plugin){
  const status=plugin.enabled?uiBadge('enabled','enabled'):uiBadge(plugin.status||'disabled','disabled');
  const source=plugin.source?.type==='github'?(plugin.source.value+(plugin.source.ref?'#'+plugin.source.ref:'')):(plugin.source?.value||plugin.installPath||'-');
  const pendingPermissions=(plugin.permissions||[]).filter(permission=>!(plugin.approvedPermissions||[]).includes(permission));
  const permissions=((plugin.permissions||[]).join(', ')||'none')+(pendingPermissions.length?' · pending approval: '+pendingPermissions.join(', '):'');
  const capabilities=pluginCapabilitiesSummary(plugin);
  const runtime=pluginMetricsSummary(plugin);
  const updateCheck=state.pluginUpdateChecks?.[plugin.id];
  const updateBadge=updateCheck?uiBadge(updateCheck.error?'check failed':updateCheck.updateAvailable?'update available':'current',updateCheck.error?'failed':updateCheck.updateAvailable?'warning':'enabled'):'';
  const trust=uiBadge(plugin.trustLevel||'untrusted',plugin.trustLevel==='official'||plugin.trustLevel==='verified'?'enabled':plugin.trustLevel==='local'?'disabled':'warning');
  const signature=plugin.signature?.status?uiBadge(plugin.signature.status,plugin.signature.status==='verified'?'enabled':plugin.signature.status==='invalid'?'failed':'warning'):'';
  const actions=[
    plugin.enabled?uiButton('Disable',{mini:true,variant:'secondary',data:{pluginDisable:plugin.id},permission:'plugins.enable'}):uiButton('Enable',{mini:true,data:{pluginEnable:plugin.id},permission:'plugins.enable'}),
    uiButton('Settings',{mini:true,variant:'secondary',data:{pluginSettings:plugin.id},permission:'plugins.settings.write'}),
    uiButton('Log',{mini:true,variant:'secondary',data:{pluginLog:plugin.id}}),
    uiButton('Reload',{mini:true,variant:'secondary',data:{pluginReload:plugin.id},permission:'plugins.install'}),
    uiButton('Check update',{mini:true,variant:'secondary',data:{pluginCheckUpdate:plugin.id},permission:'plugins.install'}),
    uiButton('Update',{mini:true,variant:'secondary',data:{pluginUpdate:plugin.id},permission:'plugins.install'}),
    uiButton('Rollback',{mini:true,variant:'secondary',data:{pluginRollback:plugin.id},permission:'plugins.install'}),
    uiButton('Remove',{mini:true,variant:'danger',data:{pluginRemove:plugin.id},permission:'plugins.install'}),
  ].join('');
  return '<tr>'+
    pluginCell('Status',status,'status-cell')+
    pluginCell('Plugin','<span class="truncate-cell" title="'+attr(plugin.name||plugin.id)+'">'+esc(plugin.name||plugin.id)+'</span><small>'+esc(plugin.id||'-')+'</small><div class="row">'+trust+signature+'</div>','primary-cell')+
    pluginCell('Version',esc(plugin.version||'-')+(updateBadge?'<br>'+updateBadge:''))+
    pluginCell('Runtime','<span class="truncate-cell" title="'+attr(runtime)+'">'+esc(runtime)+'</span>')+
    pluginCell('Source','<span class="truncate-cell" title="'+attr(source)+'">'+esc(short(source,160))+'</span>')+
    pluginCell('Permissions','<span class="truncate-cell" title="'+attr(permissions)+'">'+esc(short(permissions,120))+'</span>')+
    pluginCell('Capabilities','<span class="truncate-cell" title="'+attr(capabilities)+'">'+esc(short(capabilities,140))+'</span>')+
    pluginCell('Actions','<div class="data-table-actions">'+actions+'</div>','actions-cell')+
  '</tr>';
}
function pluginCell(label,html,cls=''){return '<td data-label="'+attr(label)+'"'+(cls?' class="'+attr(cls)+'"':'')+'>'+html+'</td>'}
function pluginCapabilitiesSummary(plugin){
  const c=plugin.capabilities||{};
  const clientScripts=(Array.isArray(c.webPanels)?c.webPanels:[]).filter(panel=>panel.allowClientScript).length;
  const parts=[
    ['commands',c.commands?.length],
    ['workflow actions',c.workflowActions?.length],
    ['web panels',c.webPanels?.length],
    ['agent adapters',c.agentAdapters?.length],
    ['chat adapters',c.chatAdapters?.length],
    ['artifact handlers',c.artifactHandlers?.length],
    ['collectors',c.collectors?.length],
  ].filter(([,count])=>Number(count)>0).map(([label,count])=>count+' '+label);
  if(c.diagnostics)parts.push('diagnostics');
  if(clientScripts)parts.push(clientScripts+' trusted UI script'+(clientScripts===1?'':'s'));
  return parts.join(', ')||'none';
}
function pluginMetricsSummary(plugin){
  const m=plugin.metrics||{};
  if(!m.invocations)return 'No invocations yet';
  const avg=Math.round((Number(m.totalDurationMs)||0)/(Number(m.invocations)||1));
  return `${m.invocations} run${Number(m.invocations)===1?'':'s'} · ${m.failures||0} failed · last ${m.lastDurationMs??'-'}ms · avg ${avg}ms`;
}
function pluginMarketplaceEntriesList(){
  return Array.isArray(state.pluginMarketplace?.entries)?state.pluginMarketplace.entries:[];
}
function marketplaceEntryById(entryId){return pluginMarketplaceEntriesList().find(item=>item.id===entryId)||null}
function marketplaceInstalledPlugin(entry){return(state.plugins||[]).find(plugin=>plugin.id===entry.id)||null}
function marketplaceCount(value){return Array.isArray(value)?value.length:0}
function marketplaceCountCell(value,label){
  const count=marketplaceCount(value);
  const text=count+' '+label+(count===1?'':'s');
  return '<span class="truncate-cell" title="'+attr((value||[]).join(', ')||'none')+'">'+esc(text)+'</span>';
}
function marketplaceCompareVersions(left,right){
  if(!left||!right)return 0;
  const a=String(left).split(/[.-]/).slice(0,3).map(part=>Number.parseInt(part,10)||0);
  const b=String(right).split(/[.-]/).slice(0,3).map(part=>Number.parseInt(part,10)||0);
  for(let i=0;i<Math.max(a.length,b.length);i++){const diff=(a[i]||0)-(b[i]||0);if(diff)return diff}
  return 0;
}
function marketplaceVersionState(installed,entry){
  if(!installed)return 'not-installed';
  if(entry.latestVersion&&marketplaceCompareVersions(installed.version,entry.latestVersion)<0)return 'outdated';
  return 'current';
}
function marketplaceInstalledCell(installed){
  if(!installed)return '<span class="muted">not installed</span>';
  return '<span class="truncate-cell" title="'+attr(installed.version||'-')+'">'+esc(installed.version||'-')+'</span>';
}
function marketplaceLatestCell(entry,installed){
  const latest=entry.latestVersion||'unknown';
  const state=marketplaceVersionState(installed,entry);
  const badge=installed&&entry.latestVersion
    ? uiBadge(state==='outdated'?'outdated':'latest',state==='outdated'?'planned':'enabled')
    : '';
  const error=entry.latestVersionError?'<small class="error">'+esc(short(entry.latestVersionError,120))+'</small>':'';
  return '<span class="truncate-cell" title="'+attr(entry.latestVersionError||latest)+'">'+esc(latest)+'</span>'+(badge?'<br>'+badge:'')+error;
}
function renderPluginMarketplace(){
  const target=document.getElementById('pluginMarketplace');
  if(!target)return;
  const entries=pluginMarketplaceEntriesList();
  if(!entries.length){target.innerHTML=uiEmpty('No marketplace plugins available.');return}
  renderIncrementalTable(target,entries,{
    key:'plugin-marketplace',
    emptyText:'No marketplace plugins available.',
    headHtml:'<tr><th>Status</th><th>Plugin</th><th>Category</th><th>Installed</th><th>Latest</th><th>Source</th><th>Permissions</th><th>Capabilities</th><th class="actions-heading">Actions</th></tr>',
    renderItem:entry=>pluginMarketplaceRow(entry),
    initialCount:30,
    batchSize:60,
    onDone:root=>{bindPluginButtons(root);applyPermissions()},
  });
}
function pluginMarketplaceRow(entry){
  const installed=marketplaceInstalledPlugin(entry);
  const versionState=marketplaceVersionState(installed,entry);
  const status=installed?(installed.enabled?uiBadge('installed · enabled','enabled'):uiBadge('installed','disabled')):uiBadge('available','disabled');
  const trust=[
    uiBadge(entry.trustLevel||'community',entry.trustLevel==='official'||entry.trustLevel==='verified'?'enabled':entry.trustLevel==='untrusted'?'failed':'warning'),
    entry.approved?uiBadge('approved','enabled'):'',
    entry.signatureRequired?uiBadge('signed','enabled'):uiBadge('unsigned ok','disabled'),
  ].filter(Boolean).join(' ');
  const source=entry.source+(entry.ref?'#'+entry.ref:'');
  const tags=(entry.tags||[]).map(tag=>'<span class="chip">'+esc(tag)+'</span>').join('');
  const installLabel=installed&&versionState==='outdated'?'Update':installed?'Reinstall':'Install';
  const actions=[
    uiButton('Info',{mini:true,variant:'secondary',data:{marketplaceInfo:entry.id}}),
    installed&&!installed.enabled?uiButton('Enable',{mini:true,data:{pluginEnable:installed.id},permission:'plugins.enable'}):'',
    uiButton(installLabel,{mini:true,data:{marketplaceInstall:entry.id,marketplaceForce:installed?'true':'false'},permission:'plugins.install'}),
    uiButton('Install all nodes',{mini:true,variant:'secondary',data:{marketplaceInstallAll:entry.id,marketplaceForce:installed?'true':'false'},permission:'plugins.install'}),
  ].filter(Boolean).join('');
  return '<tr>'+
    pluginCell('Status',status,'status-cell')+
    pluginCell('Plugin','<span class="truncate-cell" title="'+attr(entry.name||entry.id)+'">'+esc(entry.name||entry.id)+'</span><small>'+esc(entry.id||'-')+'</small><div class="row">'+trust+'</div>'+(tags?'<div class="row">'+tags+'</div>':''),'primary-cell')+
    pluginCell('Category',esc(entry.category||'-'))+
    pluginCell('Installed',marketplaceInstalledCell(installed),'version-cell')+
    pluginCell('Latest',marketplaceLatestCell(entry,installed),'version-cell')+
    pluginCell('Source','<span class="truncate-cell" title="'+attr(source)+'">'+esc(short(source,160))+'</span><small>'+esc(entry.packageName||'')+'</small>')+
    pluginCell('Permissions',marketplaceCountCell(entry.permissions||[],'permission'))+
    pluginCell('Capabilities',marketplaceCountCell(entry.capabilities||[],'capability'))+
    pluginCell('Actions','<div class="data-table-actions">'+actions+'</div>','actions-cell')+
  '</tr>';
}
function marketplaceDetailRow(label,value){
  return '<tr>'+pluginCell('Field',esc(label),'primary-cell')+pluginCell('Value','<span class="truncate-cell" title="'+attr(value??'-')+'">'+esc(value??'-')+'</span>')+'</tr>';
}
function marketplaceDetailList(title,values){
  const list=Array.isArray(values)?values:[];
  return '<details class="workflow-run-timeline" open><summary>'+esc(title+' ('+list.length+')')+'</summary>'+(list.length?'<ul>'+list.map(value=>'<li>'+esc(String(value))+'</li>').join('')+'</ul>':uiEmpty('No entries.'))+'</details>';
}
function marketplaceRawDetails(entry,installed){
  const raw={
    marketplace:entry,
    installed:installed||null,
  };
  return '<details class="workflow-run-timeline"><summary>Raw details</summary><pre class="log-view">'+esc(JSON.stringify(raw,null,2))+'</pre></details>';
}
function openPluginMarketplaceInfoDialog(entryId){
  const entry=marketplaceEntryById(entryId);
  if(!entry)return;
  const installed=marketplaceInstalledPlugin(entry);
  const source=entry.source+(entry.ref?'#'+entry.ref:'');
  const versionState=marketplaceVersionState(installed,entry);
  const rows=[
    ['ID',entry.id],
    ['Name',entry.name],
    ['Description',entry.description],
    ['Category',entry.category],
    ['Status',installed?(installed.enabled?'installed and enabled':'installed'):'available'],
    ['Version state',installed?(versionState==='outdated'?'outdated':'latest'):'not installed'],
    ['Installed version',installed?.version||'-'],
    ['Latest version',entry.latestVersion||'unknown'],
    ['Latest checked',entry.latestVersionCheckedAt?fmtDate(entry.latestVersionCheckedAt):'-'],
    ['Latest lookup error',entry.latestVersionError||'-'],
    ['Source',source],
    ['Package',entry.packageName||'-'],
    ['Repository',entry.repository||'-'],
    ['Homepage',entry.homepage||'-'],
    ['Author',entry.author||'-'],
    ['License',entry.license||'-'],
    ['Official',entry.official?'yes':'no'],
    ['Approved',entry.approved?'yes':'no'],
    ['Trust level',entry.trustLevel||'-'],
    ['Signature required',entry.signatureRequired?'yes':'no'],
    ['Verified source',entry.verifiedSource||'-'],
    ['Expected manifest hash',entry.expectedManifestHash||'-'],
    ['Expected package hash',entry.expectedPackageHash||'-'],
    ['Installed path',installed?.installPath||'-'],
    ['Installed updated',installed?.updatedAt?fmtDate(installed.updatedAt):'-'],
  ];
  const table='<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>'+rows.map(row=>marketplaceDetailRow(row[0],row[1])).join('')+'</tbody></table></div>';
  const body='<div class="full-span">'+table+
    marketplaceDetailList('Permissions',entry.permissions||[])+
    marketplaceDetailList('Capabilities',entry.capabilities||[])+
    marketplaceDetailList('Tags',entry.tags||[])+
    (installed?marketplaceDetailList('Approved permissions',installed.approvedPermissions||[]):'')+
    marketplaceRawDetails(entry,installed)+
    '</div>';
  adminDialog('Marketplace plugin: '+(entry.name||entry.id),body,async()=>{}, {submitText:'Close',reloadAccess:false});
}
function renderPluginCatalog(){
  const catalog=state.pluginCatalog||{};
  const target=document.getElementById('pluginCatalog');
  if(!target)return;
  const sections=[
    pluginCatalogSection('Workflow actions',catalog.workflowActions||[],item=>[item.pluginId,item.actionId,item.title,item.description||''],'workflow-action'),
    pluginCatalogSection('Web panels',catalog.webPanels||[],item=>[item.pluginId,item.panelId,item.title,[item.path||item.permission||'',item.allowClientScript?'client script allowed':'static panel'].filter(Boolean).join(' · ')],'web-panel'),
    pluginCatalogSection('Commands',catalog.commands||[],item=>[item.pluginId,item.name,item.title||item.description||'',item.permission||''],'command'),
    pluginCatalogSection('Agent adapters',catalog.agentAdapters||[],item=>[item.pluginId,item.id,item.title,item.description||'']),
    pluginCatalogSection('Chat adapters',catalog.chatAdapters||[],item=>[item.pluginId,item.id,item.title,item.description||'']),
    pluginCatalogSection('Artifact handlers',catalog.artifactHandlers||[],item=>[item.pluginId,item.id,item.title,item.description||''],'artifact-handler'),
    pluginCatalogSection('Diagnostics',catalog.diagnostics||[],item=>[item.pluginId,'diagnostics',item.title,''],'diagnostics'),
    pluginCatalogSection('Collectors',catalog.collectors||[],item=>[item.pluginId,item.collectorId,item.title,item.description||''],'collector'),
  ].join('');
  target.innerHTML=sections||uiEmpty('No enabled plugin extension points.');
}
function pluginCatalogSection(title,items,map,capabilityType=''){
  if(!items.length)return '';
  return '<h3 class="table-section-title">'+esc(title)+'</h3><div class="data-table-wrap"><table class="data-table plugin-catalog-table"><thead><tr><th>Plugin</th><th>ID</th><th>Title</th><th>Detail</th><th class="actions-heading">Actions</th></tr></thead><tbody>'+
    items.map(item=>{const row=map(item);const actions=capabilityType==='web-panel'?uiButton('Open',{mini:true,variant:'secondary',data:{pluginPanelOpen:row[0],pluginPanelId:row[1]},permission:'plugins.read'}):(capabilityType?uiButton(capabilityType==='diagnostics'?'Run diagnostics':capabilityType==='collector'?'Run collector':'Invoke',{mini:true,variant:'secondary',data:{pluginCapability:row[0],pluginCapabilityType:capabilityType,pluginCapabilityId:row[1]},permission:capabilityType==='diagnostics'?'diagnostics.read':capabilityType==='collector'?'plugins.install':'workflows.run'}):'');return '<tr>'+pluginCell('Plugin',esc(row[0]),'primary-cell')+pluginCell('ID',esc(row[1]))+pluginCell('Title','<span class="truncate-cell" title="'+attr(row[2])+'">'+esc(short(row[2],120))+'</span>')+pluginCell('Detail','<span class="truncate-cell" title="'+attr(row[3])+'">'+esc(short(row[3],160))+'</span>')+pluginCell('Actions','<div class="data-table-actions">'+actions+'</div>','actions-cell')+'</tr>'}).join('')+
  '</tbody></table></div>';
}
function renderPluginLogSelect(){
  const select=document.getElementById('pluginLogSelect');
  if(!select)return;
  const current=select.value;
  select.innerHTML=(state.plugins||[]).map(plugin=>'<option value="'+attr(plugin.id)+'">'+esc(plugin.name||plugin.id)+'</option>').join('');
  if(current)select.value=current;
}
function bindPluginButtons(root:Element|Document=document){
  bindUiCopyButtons(root);
  root.querySelectorAll?.('[data-plugin-enable]').forEach(b=>b.onclick=()=>safe(async()=>{await api('/api/plugins/'+encodeURIComponent(b.dataset.pluginEnable)+'/enable',{method:'POST',body:JSON.stringify({})});toast('Plugin enabled');await loadPlugins()}));
  root.querySelectorAll?.('[data-plugin-disable]').forEach(b=>b.onclick=()=>safe(async()=>{await api('/api/plugins/'+encodeURIComponent(b.dataset.pluginDisable)+'/disable',{method:'POST',body:JSON.stringify({})});toast('Plugin disabled');await loadPlugins()}));
  root.querySelectorAll?.('[data-plugin-remove]').forEach(b=>b.onclick=()=>safe(async()=>{if(!confirm('Remove this plugin?'))return;await api('/api/plugins/'+encodeURIComponent(b.dataset.pluginRemove),{method:'DELETE'});toast('Plugin removed');await loadPlugins()}));
  root.querySelectorAll?.('[data-plugin-reload]').forEach(b=>b.onclick=()=>safe(async()=>{await api('/api/plugins/'+encodeURIComponent(b.dataset.pluginReload)+'/manifest',{method:'POST',body:JSON.stringify({})});toast('Plugin manifest reloaded');await loadPlugins()}));
  root.querySelectorAll?.('[data-plugin-check-update]').forEach(b=>b.onclick=()=>safe(async()=>{const id=b.dataset.pluginCheckUpdate;const result=await api('/api/plugins/'+encodeURIComponent(id)+'/update-check');state.pluginUpdateChecks=state.pluginUpdateChecks||{};state.pluginUpdateChecks[id]=result;toast(result.updateAvailable?'Plugin update available':result.error?'Plugin update check failed':'Plugin is current');renderPlugins()}));
  root.querySelectorAll?.('[data-plugin-update]').forEach(b=>b.onclick=()=>safe(async()=>{
    const id=b.dataset.pluginUpdate;
    let check=state.pluginUpdateChecks?.[id];
    if(!check){
      check=await api('/api/plugins/'+encodeURIComponent(id)+'/update-check');
      state.pluginUpdateChecks=state.pluginUpdateChecks||{};
      state.pluginUpdateChecks[id]=check;
    }
    const diff=check?.permissionDiff&&typeof check.permissionDiff==='object'&&!Array.isArray(check.permissionDiff)?check.permissionDiff as WebuiRecord:null;
    const addedPermissions=Array.isArray(diff?.addedPermissions)?diff.addedPermissions.map(String):[];
    const riskyChanges=Array.isArray(diff?.riskyChanges)?diff.riskyChanges.map(String):[];
    const approve=Boolean(diff?.hasEscalation);
    const message=approve
      ? 'Update requires permission approval.\n\nAdded permissions: '+(addedPermissions.join(', ')||'none')+'\nRisk: '+(riskyChanges.join('; ')||'none')
      : 'Update this plugin from its original source?';
    if(!confirm(message))return;
    await api('/api/plugins/'+encodeURIComponent(id)+'/update',{method:'POST',body:JSON.stringify({approvePermissionDiff:approve})});
    toast('Plugin updated');
    await loadPlugins();
  }));
  root.querySelectorAll?.('[data-plugin-rollback]').forEach(b=>b.onclick=()=>safe(async()=>{const id=b.dataset.pluginRollback;const version=prompt('Rollback to version (leave empty for previous installed version):','')||'';await api('/api/plugins/'+encodeURIComponent(id)+'/rollback',{method:'POST',body:JSON.stringify({version:version.trim()||undefined})});toast('Plugin rolled back');await loadPlugins()}));
  root.querySelectorAll?.('[data-plugin-settings]').forEach(b=>b.onclick=()=>openPluginSettingsDialog(b.dataset.pluginSettings));
  root.querySelectorAll?.('[data-plugin-log]').forEach(b=>b.onclick=()=>{state.pluginTab='logs';switchPluginTab('logs');const select=document.getElementById('pluginLogSelect');if(select)select.value=b.dataset.pluginLog;safe(loadPluginLog)});
  root.querySelectorAll?.('[data-plugin-panel-open]').forEach(b=>b.onclick=()=>safe(()=>openPluginPanelDirect(b.dataset.pluginPanelOpen,b.dataset.pluginPanelId)));
  root.querySelectorAll?.('[data-plugin-capability]').forEach(b=>b.onclick=()=>openPluginCapabilityDialog(b.dataset.pluginCapability,b.dataset.pluginCapabilityType,b.dataset.pluginCapabilityId));
  root.querySelectorAll?.('[data-marketplace-info]').forEach(b=>b.onclick=()=>openPluginMarketplaceInfoDialog(b.dataset.marketplaceInfo));
  root.querySelectorAll?.('[data-marketplace-install]').forEach(b=>b.onclick=()=>safe(()=>installMarketplacePlugin(b.dataset.marketplaceInstall,false,b.dataset.marketplaceForce==='true')));
  root.querySelectorAll?.('[data-marketplace-install-all]').forEach(b=>b.onclick=()=>safe(()=>installMarketplacePlugin(b.dataset.marketplaceInstallAll,true,b.dataset.marketplaceForce==='true')));
}
async function openPluginPanelDirect(pluginId,panelId){
  selectPluginPanelPage(pluginId,panelId);
}
async function loadPluginPanelPage(){
  if(!can('plugins.read')){
    document.getElementById('pluginPanelPageResult').innerHTML=uiEmpty('Permission required: plugins.read');
    renderPluginPanelNav();
    return;
  }
  await refreshPluginState({force:true});
  const selected=state.pluginPanelPage;
  const inputEl=document.getElementById('pluginPanelPageInput');
  const resultEl=document.getElementById('pluginPanelPageResult');
  if(!selected?.pluginId||!selected?.panelId){
    if(inputEl)inputEl.hidden=true;
    if(resultEl)resultEl.innerHTML=uiEmpty('No plugin panel selected.');
    return;
  }
  const item=findPluginCapability(selected.pluginId,'web-panel',selected.panelId);
  if(!item){
    if(inputEl)inputEl.hidden=true;
    if(resultEl)resultEl.innerHTML='<div class="error-state">This plugin panel is no longer available or the plugin is disabled.</div>';
    renderPluginPanelNav();
    return;
  }
  state.pluginPanelPage={pluginId:item.pluginId,panelId:item.panelId,title:pluginPanelTitle(item)};
  writeStoredPluginPanelPage(state.pluginPanelPage);
  renderPageTitle();
  renderPluginPanelNav();
  if(inputEl){
    const schema=item.inputSchema||{};
    const defaults=pluginInputDefaultsFromSchema(schema);
    inputEl.hidden=!pluginInputSchemaHasRequiredFields(schema);
    inputEl.innerHTML=inputEl.hidden?'':'<div class="row"><strong>Input required</strong><button id="runPluginPanelPageBtn" class="secondary">Run panel</button></div><textarea id="pluginPanelPageInputJson" rows="6">'+esc(JSON.stringify(defaults,null,2))+'</textarea><small>Edit the panel input JSON, then run the panel.</small>';
    const runButton=document.getElementById('runPluginPanelPageBtn');
    if(runButton)runButton.onclick=()=>safe(()=>runPluginPanelPage(item,parseJsonObject(document.getElementById('pluginPanelPageInputJson')?.value||'{}','Input JSON')));
  }
  if(pluginInputSchemaHasRequiredFields(item.inputSchema||{})){
    if(resultEl)resultEl.innerHTML=uiEmpty('Panel input is required before loading.');
    return;
  }
  await runPluginPanelPage(item,pluginInputDefaultsFromSchema(item.inputSchema||{}));
}
async function runPluginPanelPage(item,input={}){
  if(item?.aggregateCommand){
    await runAggregatePluginPanelPage(item,input);
    return;
  }
  const resultEl=document.getElementById('pluginPanelPageResult');
  if(resultEl)resultEl.innerHTML=loadingHtml('Loading plugin panel...');
  const result=await invokePluginPanel(item.pluginId,item.panelId,item,input);
  renderPluginPanelPageResult(item,result,input);
}
async function reloadPluginPanelSurface(surface,input={}){
  const selected=state.pluginPanelPage;
  if(!selected?.pluginId||!selected?.panelId)return;
  const item=findPluginCapability(selected.pluginId,'web-panel',selected.panelId);
  if(!item)return;
  const defaults=pluginInputDefaultsFromSchema(item.inputSchema||{});
  const nextInput={...defaults,...(input&&typeof input==='object'?input:{})};
  if(item?.aggregateCommand){
    await reloadAggregatePluginPanelSurface(surface,item,nextInput);
    return;
  }
  const result=await invokePluginPanel(item.pluginId,item.panelId,item,nextInput);
  const target=surface instanceof HTMLElement?surface:null;
  if(target&&target.isConnected){
    renderPluginPanelSurfaceResult(target,item,result,nextInput);
    return;
  }
  renderPluginPanelPageResult(item,result,nextInput);
}
(globalThis as WebuiRecord).reloadPluginPanelSurface=reloadPluginPanelSurface;
let pluginPanelAggregateRequestSeq=0;
function pluginAggregateTargetSummary(target){
  return {id:String(target?.id||''),name:String(target?.name||target?.id||'Node'),platform:String(target?.platform||'')};
}
function pluginAggregateResultKey(item){
  const node=item?.node||{};
  return String(node.id||node.nodeId||node.name||'');
}
function pluginAggregatePendingTargets(targets,results){
  const done=new Set((Array.isArray(results)?results:[]).map(pluginAggregateResultKey).filter(Boolean));
  return (Array.isArray(targets)?targets:[]).map(pluginAggregateTargetSummary).filter(target=>target.id&&!done.has(target.id));
}
function pluginAggregateSnapshot(command,input,targets,results){
  const pending=pluginAggregatePendingTargets(targets,results);
  const sortedResults=[...(Array.isArray(results)?results:[])].sort((a,b)=>String(a?.node?.name||a?.node?.id||'').localeCompare(String(b?.node?.name||b?.node?.id||'')));
  return {command:String(command||''),generatedAt:new Date().toISOString(),input,results:sortedResults,pending,totalTargets:(Array.isArray(targets)?targets:[]).length};
}
async function renderAggregatePluginPanel(item,input,targets,results,requestId,targetSurface=null){
  if(requestId!==pluginPanelAggregateRequestSeq)return;
  const panelInput={...input,aggregate:pluginAggregateSnapshot(item.aggregateCommand,input,targets,results)};
  let result;
  try{
    result=await api('/api/plugins/'+encodeURIComponent(item.pluginId)+'/panel',{method:'POST',body:JSON.stringify({panelId:item.panelId,input:panelInput}),timeoutMs:12000});
  }catch(error){
    result={ok:false,error:error instanceof Error?error.message:String(error)};
  }
  if(requestId!==pluginPanelAggregateRequestSeq)return;
  if(targetSurface instanceof HTMLElement&&targetSurface.isConnected){
    renderPluginPanelSurfaceResult(targetSurface,item,result,panelInput);
  }else{
    renderPluginPanelPageResult(item,result,panelInput);
  }
}
function shouldSkipPluginAggregateClientError(message){
  return /plugin not found|plugins are disabled|plugin is disabled|access denied|api key permissions|remote endpoint is not allowed/i.test(String(message||''));
}
async function invokePluginAggregateTarget(pluginId,command,input,target){
  const body=JSON.stringify({command:String(command||''),input});
  return target.id==='local'
    ? api('/api/plugins/'+encodeURIComponent(pluginId)+'/command',{method:'POST',local:true,body,timeoutMs:12000})
    : apiPeer(target.id,'/api/plugins/'+encodeURIComponent(pluginId)+'/command',{method:'POST',body,timeoutMs:12000});
}
async function runAggregatePluginPanelPage(item,input={}){
  const resultEl=document.getElementById('pluginPanelPageResult');
  if(resultEl)resultEl.innerHTML=loadingHtml('Preparing plugin panel...');
  const requestId=++pluginPanelAggregateRequestSeq;
  const targets=await pluginAggregateTargets();
  const results=[];
  await renderAggregatePluginPanel(item,input,targets,results,requestId);
  await runPluginAggregateTargets(item,input,targets,results,requestId,null);
}
async function reloadAggregatePluginPanelSurface(surface,item,input={}){
  const requestId=++pluginPanelAggregateRequestSeq;
  const target=surface instanceof HTMLElement?surface:null;
  const targets=await pluginAggregateTargets();
  const results=[];
  await renderAggregatePluginPanel(item,input,targets,results,requestId,target);
  await runPluginAggregateTargets(item,input,targets,results,requestId,target);
}
async function runPluginAggregateTargets(item,input,targets,results,requestId,targetSurface){
  await Promise.all((targets||[]).map(async target=>{
    try{
      const result=await invokePluginAggregateTarget(item.pluginId,item.aggregateCommand,input,target);
      results.push({node:pluginAggregateTargetSummary(target),ok:result?.ok!==false,result});
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      if(!shouldSkipPluginAggregateClientError(message))results.push({node:pluginAggregateTargetSummary(target),ok:false,error:message});
    }
    await renderAggregatePluginPanel(item,input,targets,results,requestId,targetSurface);
  }));
}
function renderPluginPanelPageResult(item,result,input={}){
  const resultEl=document.getElementById('pluginPanelPageResult');
  if(!resultEl)return;
  cleanupPluginPanelSurfaces(resultEl);
  const html=pluginPanelHtmlFromResult(result);
  const extracted=html?pluginPanelExtractExecutableHtml(html):null;
  const renderResult={...result,__pluginPanelScripts:extracted?.scripts||[],__pluginPanelStyles:extracted?.styles||[]};
  const peerId=String(state.selectedPeer||'local');
  resultEl.innerHTML=extracted
    ? pluginPanelInlineHtml(extracted.html,pluginPanelTitle(item),{pluginId:item.pluginId,capabilityId:item.panelId,peerId},'plugin-panel-page-surface')
    : '<pre class="log-view">'+esc(JSON.stringify(result.output??result.diagnostics??result.text??result.stdout??result,null,2))+'</pre>';
  resultEl.querySelectorAll<HTMLElement>('[data-plugin-panel-surface]').forEach(surface=>bindPluginPanelSurface(surface,item,renderResult,input));
}
function renderPluginPanelSurfaceResult(surface,item,result,input={}){
  const html=pluginPanelHtmlFromResult(result);
  const extracted=html?pluginPanelExtractExecutableHtml(html):null;
  const renderResult={...result,__pluginPanelScripts:extracted?.scripts||[],__pluginPanelStyles:extracted?.styles||[]};
  cleanupPluginPanelSurface(surface);
  surface.removeAttribute('data-plugin-panel-bound');
  surface.dataset.pluginId=item.pluginId||'';
  surface.dataset.pluginPanelId=item.panelId||'';
  surface.dataset.pluginPeerId=String(state.selectedPeer||'local');
  surface.dataset.pluginTitle=pluginPanelTitle(item);
  surface.innerHTML=extracted
    ? extracted.html
    : '<pre class="log-view">'+esc(JSON.stringify(result.output??result.diagnostics??result.text??result.stdout??result,null,2))+'</pre>';
  if(extracted)bindPluginPanelSurface(surface,item,renderResult,input);
}
function pluginPanelHtmlFromResult(result){
  if(result?.panel&&typeof result.panel==='object'&&!Array.isArray(result.panel)){
    const html=pluginPanelRawHtml(result.panel.html)||pluginPanelLooseHtml(result.panel.html);
    if(html)return html;
  }
  const looseHtml=pluginPanelLooseHtml(result);
  if(looseHtml)return looseHtml;
  const normalized=pluginPanelJsonObject(result);
  if(!normalized)return '';
  return pluginPanelHtmlFromObject(normalized);
}
function pluginPanelHtmlFromObject(result){
  const looseHtml=pluginPanelLooseHtml(result.html)||pluginPanelLooseHtml(result.output)||pluginPanelLooseHtml(result.stdout)||pluginPanelLooseHtml(result.text);
  if(looseHtml)return looseHtml;
  const directHtml=pluginPanelRawHtml(result.html);
  if(directHtml)return directHtml;
  const htmlObject=pluginPanelJsonObject(result.html);
  if(htmlObject){
    const html=pluginPanelHtmlFromObject(htmlObject);
    if(html)return html;
  }
  const outputHtml=pluginPanelRawHtml(result.output);
  if(outputHtml)return outputHtml;
  const output=pluginPanelJsonObject(result.output);
  if(output){
    const html=pluginPanelHtmlFromObject(output);
    if(html)return html;
  }
  const parsed=pluginPanelJsonObject(result.stdout);
  if(parsed)return pluginPanelHtmlFromObject(parsed);
  return '';
}
function pluginPanelLooseHtml(value,depth=0){
  if(value===undefined||value===null||depth>10)return '';
  const raw=pluginPanelRawHtml(value);
  if(raw)return raw;
  if(typeof value==='object'&&!Array.isArray(value)){
    return pluginPanelLooseHtml(value.html,depth+1)||pluginPanelLooseHtml(value.output,depth+1)||pluginPanelLooseHtml(value.stdout,depth+1)||pluginPanelLooseHtml(value.text,depth+1);
  }
  if(typeof value!=='string')return '';
  const text=value.trim();
  if(!text)return '';
  try{
    return pluginPanelLooseHtml(JSON.parse(text),depth+1);
  }catch{
    const normalized=pluginPanelNormalizeSerializedText(text);
    if(normalized!==text){
      const parsed=pluginPanelJsonObject(normalized);
      if(parsed)return pluginPanelHtmlFromObject(parsed);
      const rawHtml=pluginPanelRawHtml(normalized);
      if(rawHtml)return rawHtml;
      return pluginPanelExtractEmbeddedHtml(normalized);
    }
    return pluginPanelExtractEmbeddedHtml(text);
  }
}
function pluginPanelNormalizeSerializedText(text){
  let current=String(text||'').trim();
  for(let i=0;i<8;i++){
    const next=current
      .replace(/&quot;/g,'"')
      .replace(/&#34;/g,'"')
      .replace(/&lt;/g,'<')
      .replace(/&gt;/g,'>')
      .replace(/&amp;/g,'&')
      .replace(/\\\\n/g,'\n')
      .replace(/\\n/g,'\n')
      .replace(/\\\\r/g,'')
      .replace(/\\r/g,'')
      .replace(/\\\\"/g,'\\"')
      .replace(/\\"/g,'"');
    if(next===current)break;
    current=next;
  }
  return current;
}
function pluginPanelExtractEmbeddedHtml(text){
  const normalized=pluginPanelNormalizeSerializedText(text);
  const match=normalized.match(/"html"\s*:\s*"([\s\S]*?)"\s*(?:[,}])/);
  if(match?.[1]){
    const raw=pluginPanelNormalizeSerializedText(match[1]);
    if(pluginPanelRawHtml(raw))return raw;
  }
  const start=normalized.search(/<(?:!doctype|html|body|main|section|article|div|table|svg|canvas|pre|h1|h2|p|span)\b/i);
  if(start<0)return '';
  let html=normalized.slice(start).replace(/"\s*}\s*"?\s*$/,'');
  html=pluginPanelNormalizeSerializedText(html);
  return pluginPanelRawHtml(html)?html:'';
}
function pluginPanelJsonObject(value,depth=0){
  if(!value||depth>10)return null;
  if(typeof value==='string'){
    const text=value.trim();
    if(!text)return null;
    try{
      return pluginPanelJsonObject(JSON.parse(text),depth+1);
    }catch{
      const unescaped=pluginPanelEscapedJsonString(text);
      return unescaped===null?null:pluginPanelJsonObject(unescaped,depth+1);
    }
  }
  return typeof value==='object'&&!Array.isArray(value)?value:null;
}
function pluginPanelEscapedJsonString(text){
  if(!/^[{\[]/.test(text)||!text.includes('\\"'))return null;
  const normalized=text.replace(/\\"/g,'"');
  try{
    JSON.parse(normalized);
    return normalized;
  }catch{
    return null;
  }
}
function pluginPanelRawHtml(value){
  if(typeof value!=='string')return '';
  const text=value.trim();
  return text.startsWith('<')?text:'';
}
function openPluginCapabilityDialog(pluginId,type,capabilityId){
  const item=findPluginCapability(pluginId,type,capabilityId);
  const schema=item?.inputSchema||{};
  const defaults=pluginInputDefaultsFromSchema(schema);
  const fields='<label class="full-span"><span>Input JSON</span><textarea id="dlgPluginCapabilityInput" rows="8">'+esc(JSON.stringify(defaults,null,2))+'</textarea><small>Input is passed to the selected plugin capability. Plugin output appears in the catalog result panel.</small></label>';
  adminDialog('Invoke '+type+': '+capabilityId,fields,async()=>{
    let input=parseJsonObject(document.getElementById('dlgPluginCapabilityInput')?.value||'{}','Input JSON');
    let endpoint='/invoke';
    let body:WebuiRecord={input};
    if(type==='workflow-action')body={actionId:capabilityId,input};
    else if(type==='command'){endpoint='/command';body={command:capabilityId,input}}
    else if(type==='web-panel'){endpoint='/panel';body={panelId:capabilityId,input}}
    else if(type==='artifact-handler'){endpoint='/artifact-handler';body={handlerId:capabilityId,input}}
    else if(type==='collector'){endpoint='/collector';body={collectorId:capabilityId,input}}
    else if(type==='diagnostics'){endpoint='/diagnostics';body={}}
    const result=type==='web-panel'
      ? await invokePluginPanel(pluginId,capabilityId,item,input)
      : await api('/api/plugins/'+encodeURIComponent(pluginId)+endpoint,{method:type==='diagnostics'?'GET':'POST',body:type==='diagnostics'?undefined:JSON.stringify(body)});
    renderPluginCapabilityResult(pluginId,type,capabilityId,result);
    await loadPlugins();
  },{submitText:'Run',reloadAccess:false});
}
async function invokePluginPanel(pluginId,panelId,item,input={}){
  let panelInput={...input};
  if(item?.aggregateCommand)panelInput={...panelInput,aggregate:await collectPluginAggregate(pluginId,item.aggregateCommand,panelInput)};
  return api('/api/plugins/'+encodeURIComponent(pluginId)+'/panel',{method:'POST',body:JSON.stringify({panelId,input:panelInput}),timeoutMs:item?.aggregateCommand?30000:undefined});
}
function findPluginCapability(pluginId,type,capabilityId){
  const c=state.pluginCatalog||{};
  const value=type==='workflow-action'?c.workflowActions:type==='command'?c.commands:type==='web-panel'?c.webPanels:type==='artifact-handler'?c.artifactHandlers:type==='diagnostics'?c.diagnostics:type==='collector'?c.collectors:[];
  const list:WebuiRecord[]=Array.isArray(value)?value:[];
  return list.find(item=>item.pluginId===pluginId&&(item.actionId===capabilityId||item.name===capabilityId||item.panelId===capabilityId||item.collectorId===capabilityId||item.id===capabilityId||capabilityId==='diagnostics'));
}
function pluginInputDefaultsFromSchema(schema){
  const properties=schema&&typeof schema==='object'&&!Array.isArray(schema)?schema.properties:null;
  if(!properties||typeof properties!=='object')return {};
  return Object.fromEntries(Object.entries(properties).map(([key,value])=>{const meta=value as WebuiRecord;return [key,meta?.default??(meta?.type==='boolean'?false:meta?.type==='number'?0:'')]}));
}
function pluginInputSchemaHasRequiredFields(schema){
  if(!schema||typeof schema!=='object'||Array.isArray(schema))return false;
  return Array.isArray(schema.required)&&schema.required.length>0;
}
function parseJsonObject(text,label){
  const parsed=text.trim()?JSON.parse(text):{};
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error(label+' must be a JSON object.');
  return parsed;
}
function renderPluginCapabilityResult(pluginId,type,capabilityId,result){
  const target=document.getElementById('pluginCapabilityResult');
  if(!target)return;
  cleanupPluginPanelSurfaces(target);
  const html=pluginPanelHtmlFromResult(result);
  const item=findPluginCapability(pluginId,type,capabilityId)||{};
  const extracted=html?pluginPanelExtractExecutableHtml(html):null;
  const renderResult={...result,__pluginPanelScripts:extracted?.scripts||[],__pluginPanelStyles:extracted?.styles||[]};
  const output=html
    ? pluginPanelInlineHtml(extracted?.html||html,pluginId+' / '+capabilityId,{pluginId,capabilityId,peerId:String(state.selectedPeer||'local')})
    : '<pre class="log-view">'+esc(JSON.stringify(result.output??result.diagnostics??result.text??result.stdout??result,null,2))+'</pre>';
  target.innerHTML=uiItem(pluginId+' / '+capabilityId,{badge:{text:result.ok?'ok':'failed',status:result.ok?'enabled':'failed'},rows:[['Type',type],['Duration',result.durationMs?result.durationMs+'ms':'-']],body:output});
  const panelTarget=document.getElementById('pluginPanelResult');
  if(panelTarget&&type==='web-panel')panelTarget.innerHTML=target.innerHTML;
  target.querySelectorAll<HTMLElement>('[data-plugin-panel-surface]').forEach(surface=>bindPluginPanelSurface(surface,item,renderResult,{}));
  if(panelTarget&&type==='web-panel')panelTarget.querySelectorAll<HTMLElement>('[data-plugin-panel-surface]').forEach(surface=>bindPluginPanelSurface(surface,item,renderResult,{}));
}
function openPluginSettingsDialog(pluginId){
  const plugin=(state.plugins||[]).find(item=>item.id===pluginId);
  if(!plugin)return;
  const schema=Array.isArray(plugin.settingsSchema)?plugin.settingsSchema:[];
  const fields=schema.map(setting=>{
    const key=String(setting.key||'');
    const value=plugin.settings?.[key]??'';
    if(setting.type==='boolean')return '<label class="checkbox"><input id="dlgPluginSetting_'+attr(key)+'" type="checkbox" '+(value?'checked':'')+'> '+esc(setting.label)+'</label>';
    if(setting.type==='select'){const options=Array.isArray(setting.options)?setting.options:[];return '<label><span>'+esc(setting.label)+'</span><select id="dlgPluginSetting_'+attr(key)+'">'+options.map(option=>'<option value="'+attr(option.value)+'" '+(String(value)===String(option.value)?'selected':'')+'>'+esc(option.label)+'</option>').join('')+'</select><small>'+esc(setting.description||'')+'</small></label>'}
    const type=setting.type==='secret'?'password':setting.type==='number'?'number':'text';
    return '<label><span>'+esc(setting.label)+'</span><input id="dlgPluginSetting_'+attr(key)+'" type="'+type+'" value="'+attr(value)+'"><small>'+esc(setting.description||'')+'</small></label>';
  }).join('')||'<p>This plugin does not define settings.</p>';
  adminDialog('Plugin settings: '+plugin.name,fields,async()=>{
    const settings={};
    schema.forEach(setting=>{
      const key=String(setting.key||'');
      const input=document.getElementById('dlgPluginSetting_'+key);
      settings[key]=setting.type==='boolean'?Boolean(input?.checked):(input?.value??'');
    });
    await api('/api/plugins/'+encodeURIComponent(String(plugin.id))+'/settings',{method:'PATCH',body:JSON.stringify({settings})});
    toast('Plugin settings updated');
    await loadPlugins();
  },{submitText:'Save settings',reloadAccess:false});
}
async function installPluginFromForm(){
  const source=val('pluginInstallSource');
  if(!source)throw new Error('Plugin source is required.');
  const payload={
    source,
    ref:val('pluginInstallRef')||undefined,
    enable:document.getElementById('pluginInstallEnable')?.checked===true,
    approvePermissions:document.getElementById('pluginInstallApprove')?.checked===true,
    approvePermissionDiff:document.getElementById('pluginInstallApprove')?.checked===true,
    force:document.getElementById('pluginInstallForce')?.checked===true,
    trustLevel:val('pluginInstallTrust')||undefined,
    expectedManifestHash:val('pluginInstallManifestHash')||undefined,
    expectedPackageHash:val('pluginInstallPackageHash')||undefined,
    signaturePublicKey:val('pluginInstallSignatureKey')||undefined,
    requireSignature:document.getElementById('pluginInstallRequireSignature')?.checked===true,
  };
  const allPeers=document.getElementById('pluginInstallAllPeers')?.checked===true;
  if(allPeers){
    const results=await installPluginOnAllTargets(payload);
    document.getElementById('pluginInstallResult').innerHTML=renderPluginInstallResults(results);
    toast('Plugin install completed on '+results.length+' node(s)');
    await loadPlugins();
    return;
  }
  const result=await api('/api/plugins',{method:'POST',body:JSON.stringify(payload)});
  document.getElementById('pluginInstallResult').innerHTML=uiItem('Installed '+(result.name||result.id),{badge:{text:result.enabled?'enabled':'disabled',status:result.enabled?'enabled':'disabled'},rows:[['Node',headerTargetName(state.selectedPeer||'local')],['ID',result.id],['Version',result.version],['Permissions',(result.permissions||[]).join(', ')||'none']]});
  toast('Plugin installed');
  await loadPlugins();
}
async function installMarketplacePlugin(entryId,allTargets=false,force=false){
  const entry=pluginMarketplaceEntriesList().find(item=>item.id===entryId);
  if(!entry)throw new Error('Marketplace plugin not found.');
  const payload={
    source:entry.source,
    ref:entry.ref||undefined,
    enable:true,
    approvePermissions:entry.approved!==false,
    approvePermissionDiff:entry.approved!==false,
    trustLevel:entry.trustLevel||undefined,
    expectedManifestHash:entry.expectedManifestHash||undefined,
    expectedPackageHash:entry.expectedPackageHash||undefined,
    requireSignature:Boolean(entry.signatureRequired),
    force:Boolean(force),
  };
  if(!entry.approved&&!confirm('This plugin is not marked as approved. Install without approving permissions?'))return;
  if(allTargets){
    const results=await installPluginOnAllTargets(payload);
    document.getElementById('pluginMarketplaceResult').innerHTML=renderPluginInstallResults(results);
    toast('Marketplace install completed on '+results.length+' node(s)');
    await loadPlugins();
    return;
  }
  const result=await api('/api/plugins',{method:'POST',body:JSON.stringify(payload),timeoutMs:30000});
  document.getElementById('pluginMarketplaceResult').innerHTML=uiItem('Installed '+(result.name||result.id),{badge:{text:result.enabled?'enabled':'disabled',status:result.enabled?'enabled':'disabled'},rows:[['Node',headerTargetName(state.selectedPeer||'local')],['ID',result.id],['Version',result.version],['Permissions',(result.permissions||[]).join(', ')||'none']]});
  toast('Marketplace plugin installed');
  await loadPlugins();
}
async function validatePluginSource(){
  const source=val('pluginInstallSource');
  if(!source)throw new Error('Local plugin path is required.');
  const result=await api('/api/plugins/validate',{method:'POST',body:JSON.stringify({source})});
  document.getElementById('pluginInstallResult').innerHTML=uiItem(result.ok?'Manifest is valid':'Manifest has issues',{badge:{text:result.ok?'valid':'invalid',status:result.ok?'enabled':'disabled'},body:(result.issues||[]).map(issue=>'<small>'+esc(issue.level.toUpperCase()+': '+issue.message)+'</small>').join('')});
}
async function createPluginScaffold(){
  const pathValue=val('pluginScaffoldDir');
  const id=val('pluginScaffoldId');
  if(!pathValue||!id)throw new Error('Target directory and plugin id are required.');
  const result=await api('/api/plugins/scaffold',{method:'POST',local:true,body:JSON.stringify({targetDir:pathValue,id,name:val('pluginScaffoldName')||undefined,description:val('pluginScaffoldDescription')||undefined})});
  document.getElementById('pluginDeveloperResult').innerHTML=uiItem('Plugin scaffold created',{rows:[['Path',result.path]],body:'<small>Validate or install this path from the Install tab.</small>'});
  toast('Plugin scaffold created');
}
async function loadPluginLog(){
  const select=document.getElementById('pluginLogSelect');
  const id=select?.value;
  if(!id){document.getElementById('pluginLog').textContent='No plugin selected.';return}
  const result=await api('/api/plugins/'+encodeURIComponent(id)+'/log');
  document.getElementById('pluginLog').textContent=result.log||'No plugin log entries.';
}
async function collectPluginAggregate(pluginId,command,input={}){
  return api('/api/plugins/'+encodeURIComponent(pluginId)+'/aggregate-command',{method:'POST',local:true,body:JSON.stringify({command,input}),timeoutMs:30000});
}
async function pluginAggregateTargets(){
  if(!state.peers&&can('peers.read'))state.peers=await api('/api/peers',{local:true}).catch(()=>state.peers);
  const local={id:'local',name:'Local node',platform:navigator.platform||'local'};
  const peers=(state.peers?.peers||[]).filter(peer=>peer.enabled!==false&&peer.id).map(peer=>({id:String(peer.id),name:String(peer.name||peer.id),platform:String(peer.platform||peer.remotePlatform||'')}));
  return [local,...peers];
}
async function installPluginOnAllTargets(payload){
  const targets=await pluginAggregateTargets();
  const results=[];
  for(const target of targets){
    try{
      const result=target.id==='local'
        ? await api('/api/plugins',{method:'POST',local:true,body:JSON.stringify(payload),timeoutMs:30000})
        : await apiPeer(target.id,'/api/plugins',{method:'POST',body:JSON.stringify(payload),timeoutMs:30000});
      results.push({target,ok:true,result});
    }catch(error){
      results.push({target,ok:false,error:error instanceof Error?error.message:String(error)});
    }
  }
  return results;
}
function renderPluginInstallResults(results){
  return '<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Node</th><th>Status</th><th>Plugin</th><th>Detail</th></tr></thead><tbody>'+
    results.map(item=>'<tr>'+pluginCell('Node',esc(item.target.name),'primary-cell')+pluginCell('Status',uiBadge(item.ok?'installed':'failed',item.ok?'enabled':'failed'))+pluginCell('Plugin',esc(item.result?.id||'-'))+pluginCell('Detail','<span class="truncate-cell" title="'+attr(item.error||item.result?.version||'')+'">'+esc(item.error||item.result?.version||'')+'</span>')+'</tr>').join('')+
  '</tbody></table></div>';
}
document.getElementById('reloadPluginsBtn').onclick=()=>safe(loadPlugins);
document.getElementById('reloadPluginMarketplaceBtn').onclick=()=>safe(async()=>{await refreshPluginMarketplace({force:true});renderPluginMarketplace();toast('Marketplace refreshed')});
document.getElementById('reloadPluginCatalogBtn').onclick=()=>safe(loadPlugins);
const reloadPluginPanelPageBtn=document.getElementById('reloadPluginPanelPageBtn');
if(reloadPluginPanelPageBtn)reloadPluginPanelPageBtn.onclick=()=>safe(loadPluginPanelPage);
document.getElementById('installPluginBtn').onclick=()=>safe(installPluginFromForm);
document.getElementById('validatePluginSourceBtn').onclick=()=>safe(validatePluginSource);
document.getElementById('createPluginScaffoldBtn').onclick=()=>safe(createPluginScaffold);
document.getElementById('loadPluginLogBtn').onclick=()=>safe(loadPluginLog);
