async function loadPlugins(){
  bindPluginTabs();
  switchPluginTab(state.pluginTab||'installed');
  if(!can('plugins.read')){
    document.getElementById('pluginList').innerHTML=uiEmpty('Permission required: plugins.read');
    return;
  }
  setLoading('pluginList','Loading plugins...');
  setLoading('pluginCatalog','Loading plugin catalog...');
  const data=await api('/api/plugins',{local:true});
  const response=Array.isArray(data.plugins)?data:{enabled:true,plugins:[],catalog:{}};
  state.plugins=response.plugins||[];
  state.pluginCatalog=response.catalog||{};
  document.getElementById('pluginStatus').innerHTML=response.enabled?'Plugins are enabled.':'Plugins are disabled by NORDRELAY_PLUGINS_ENABLED=false.';
  renderPlugins();
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
  renderPluginCatalog();
  renderPluginLogSelect();
  bindPluginButtons();
  applyPermissions();
}
function renderPluginList(){
  const plugins=state.plugins||[];
  const target=document.getElementById('pluginList');
  if(!target)return;
  if(!plugins.length){target.innerHTML=uiEmpty('No plugins installed.');return}
  renderIncrementalTable(target,plugins,{
    key:'plugins',
    emptyText:'No plugins installed.',
    headHtml:'<tr><th>Status</th><th>Plugin</th><th>Version</th><th>Source</th><th>Permissions</th><th>Capabilities</th><th class="actions-heading">Actions</th></tr>',
    renderItem:plugin=>pluginRow(plugin),
    initialCount:30,
    batchSize:60,
    onDone:root=>{bindPluginButtons(root);applyPermissions()},
  });
}
function pluginRow(plugin){
  const status=plugin.enabled?uiBadge('enabled','enabled'):uiBadge(plugin.status||'disabled','disabled');
  const source=plugin.source?.type==='github'?(plugin.source.value+(plugin.source.ref?'#'+plugin.source.ref:'')):(plugin.source?.value||plugin.installPath||'-');
  const permissions=(plugin.permissions||[]).join(', ')||'none';
  const capabilities=pluginCapabilitiesSummary(plugin);
  const actions=[
    plugin.enabled?uiButton('Disable',{mini:true,variant:'secondary',data:{pluginDisable:plugin.id},permission:'plugins.enable'}):uiButton('Enable',{mini:true,data:{pluginEnable:plugin.id},permission:'plugins.enable'}),
    uiButton('Settings',{mini:true,variant:'secondary',data:{pluginSettings:plugin.id},permission:'plugins.settings.write'}),
    uiButton('Log',{mini:true,variant:'secondary',data:{pluginLog:plugin.id}}),
    uiButton('Reload',{mini:true,variant:'secondary',data:{pluginReload:plugin.id},permission:'plugins.install'}),
    uiButton('Remove',{mini:true,variant:'danger',data:{pluginRemove:plugin.id},permission:'plugins.install'}),
  ].join('');
  return '<tr>'+
    pluginCell('Status',status,'status-cell')+
    pluginCell('Plugin','<span class="truncate-cell" title="'+attr(plugin.name||plugin.id)+'">'+esc(plugin.name||plugin.id)+'</span><small>'+esc(plugin.id||'-')+'</small>','primary-cell')+
    pluginCell('Version',esc(plugin.version||'-'))+
    pluginCell('Source','<span class="truncate-cell" title="'+attr(source)+'">'+esc(short(source,160))+'</span>')+
    pluginCell('Permissions','<span class="truncate-cell" title="'+attr(permissions)+'">'+esc(short(permissions,120))+'</span>')+
    pluginCell('Capabilities','<span class="truncate-cell" title="'+attr(capabilities)+'">'+esc(short(capabilities,140))+'</span>')+
    pluginCell('Actions','<div class="data-table-actions">'+actions+'</div>','actions-cell')+
  '</tr>';
}
function pluginCell(label,html,cls=''){return '<td data-label="'+attr(label)+'"'+(cls?' class="'+attr(cls)+'"':'')+'>'+html+'</td>'}
function pluginCapabilitiesSummary(plugin){
  const c=plugin.capabilities||{};
  const parts=[
    ['commands',c.commands?.length],
    ['workflow actions',c.workflowActions?.length],
    ['web panels',c.webPanels?.length],
    ['agent adapters',c.agentAdapters?.length],
    ['chat adapters',c.chatAdapters?.length],
    ['artifact handlers',c.artifactHandlers?.length],
  ].filter(([,count])=>Number(count)>0).map(([label,count])=>count+' '+label);
  if(c.diagnostics)parts.push('diagnostics');
  return parts.join(', ')||'none';
}
function renderPluginCatalog(){
  const catalog=state.pluginCatalog||{};
  const target=document.getElementById('pluginCatalog');
  if(!target)return;
  const sections=[
    pluginCatalogSection('Workflow actions',catalog.workflowActions||[],item=>[item.pluginId,item.actionId,item.title,item.description||'']),
    pluginCatalogSection('Web panels',catalog.webPanels||[],item=>[item.pluginId,item.panelId,item.title,item.path||item.permission||'']),
    pluginCatalogSection('Commands',catalog.commands||[],item=>[item.pluginId,item.name,item.description||'',item.permission||'']),
    pluginCatalogSection('Agent adapters',catalog.agentAdapters||[],item=>[item.pluginId,item.id,item.title,item.description||'']),
    pluginCatalogSection('Chat adapters',catalog.chatAdapters||[],item=>[item.pluginId,item.id,item.title,item.description||'']),
    pluginCatalogSection('Artifact handlers',catalog.artifactHandlers||[],item=>[item.pluginId,item.id,item.title,item.description||'']),
  ].join('');
  target.innerHTML=sections||uiEmpty('No enabled plugin extension points.');
}
function pluginCatalogSection(title,items,map){
  if(!items.length)return '';
  return '<h3 class="table-section-title">'+esc(title)+'</h3><div class="data-table-wrap"><table class="data-table plugin-catalog-table"><thead><tr><th>Plugin</th><th>ID</th><th>Title</th><th>Detail</th></tr></thead><tbody>'+
    items.map(item=>{const row=map(item);return '<tr>'+pluginCell('Plugin',esc(row[0]),'primary-cell')+pluginCell('ID',esc(row[1]))+pluginCell('Title','<span class="truncate-cell" title="'+attr(row[2])+'">'+esc(short(row[2],120))+'</span>')+pluginCell('Detail','<span class="truncate-cell" title="'+attr(row[3])+'">'+esc(short(row[3],160))+'</span>')+'</tr>'}).join('')+
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
  root.querySelectorAll?.('[data-plugin-enable]').forEach(b=>b.onclick=()=>safe(async()=>{await api('/api/plugins/'+encodeURIComponent(b.dataset.pluginEnable)+'/enable',{method:'POST',local:true,body:JSON.stringify({})});toast('Plugin enabled');await loadPlugins()}));
  root.querySelectorAll?.('[data-plugin-disable]').forEach(b=>b.onclick=()=>safe(async()=>{await api('/api/plugins/'+encodeURIComponent(b.dataset.pluginDisable)+'/disable',{method:'POST',local:true,body:JSON.stringify({})});toast('Plugin disabled');await loadPlugins()}));
  root.querySelectorAll?.('[data-plugin-remove]').forEach(b=>b.onclick=()=>safe(async()=>{if(!confirm('Remove this plugin?'))return;await api('/api/plugins/'+encodeURIComponent(b.dataset.pluginRemove),{method:'DELETE',local:true});toast('Plugin removed');await loadPlugins()}));
  root.querySelectorAll?.('[data-plugin-reload]').forEach(b=>b.onclick=()=>safe(async()=>{await api('/api/plugins/'+encodeURIComponent(b.dataset.pluginReload)+'/manifest',{method:'POST',local:true,body:JSON.stringify({})});toast('Plugin manifest reloaded');await loadPlugins()}));
  root.querySelectorAll?.('[data-plugin-settings]').forEach(b=>b.onclick=()=>openPluginSettingsDialog(b.dataset.pluginSettings));
  root.querySelectorAll?.('[data-plugin-log]').forEach(b=>b.onclick=()=>{state.pluginTab='logs';switchPluginTab('logs');const select=document.getElementById('pluginLogSelect');if(select)select.value=b.dataset.pluginLog;safe(loadPluginLog)});
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
    await api('/api/plugins/'+encodeURIComponent(String(plugin.id))+'/settings',{method:'PATCH',local:true,body:JSON.stringify({settings})});
    toast('Plugin settings updated');
    await loadPlugins();
  },{submitText:'Save settings',reloadAccess:false});
}
async function installPluginFromForm(){
  const source=val('pluginInstallSource');
  if(!source)throw new Error('Plugin source is required.');
  const result=await api('/api/plugins',{method:'POST',local:true,body:JSON.stringify({
    source,
    ref:val('pluginInstallRef')||undefined,
    enable:document.getElementById('pluginInstallEnable')?.checked===true,
    approvePermissions:document.getElementById('pluginInstallApprove')?.checked===true,
    force:document.getElementById('pluginInstallForce')?.checked===true,
  })});
  document.getElementById('pluginInstallResult').innerHTML=uiItem('Installed '+(result.name||result.id),{badge:{text:result.enabled?'enabled':'disabled',status:result.enabled?'enabled':'disabled'},rows:[['ID',result.id],['Version',result.version],['Permissions',(result.permissions||[]).join(', ')||'none']]});
  toast('Plugin installed');
  await loadPlugins();
}
async function validatePluginSource(){
  const source=val('pluginInstallSource');
  if(!source)throw new Error('Local plugin path is required.');
  const result=await api('/api/plugins/validate',{method:'POST',local:true,body:JSON.stringify({source})});
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
  const result=await api('/api/plugins/'+encodeURIComponent(id)+'/log',{local:true});
  document.getElementById('pluginLog').textContent=result.log||'No plugin log entries.';
}
document.getElementById('reloadPluginsBtn').onclick=()=>safe(loadPlugins);
document.getElementById('reloadPluginCatalogBtn').onclick=()=>safe(loadPlugins);
document.getElementById('installPluginBtn').onclick=()=>safe(installPluginFromForm);
document.getElementById('validatePluginSourceBtn').onclick=()=>safe(validatePluginSource);
document.getElementById('createPluginScaffoldBtn').onclick=()=>safe(createPluginScaffold);
document.getElementById('loadPluginLogBtn').onclick=()=>safe(loadPluginLog);
