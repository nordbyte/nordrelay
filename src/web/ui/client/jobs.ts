async function loadTasks(reset=true){
  if(reset)jobsPager.reset();
  setLoading('tasksList','Loading tasks...');
  const [d,jobs]=await Promise.all([api('/api/tasks'),api('/api/jobs',{query:{limit:100,cursor:jobsPager.cursor||undefined}})]);
  renderTasks(d,jobs);
  jobsPager.render(jobs?.pagination||{});
}
function taskCard(t,title){
  if(!t)return '<div class="item"><strong>'+esc(title)+'</strong><small>Idle</small></div>';
  const tools=(t.tools||[]).map(x=>x.name+' x'+x.count).join(', ')||'-';
  return '<div class="item"><strong>'+esc(title+' · '+t.status)+'</strong><small>'+esc((t.agentLabel||t.agentId||t.source)+' / '+(t.threadId||'-'))+'</small>'+(t.correlationId?'<small>'+uiTraceControls(t.correlationId)+'</small>':'')+'<small>'+esc('Elapsed '+fmtDuration(t.durationMs)+' / current '+(t.currentTool||'-')+' / last '+(t.lastTool||'-'))+'</small><small>'+esc('Tools: '+tools+' / output chars '+(t.outputChars||0))+'</small><small>'+esc(t.prompt||t.detail||'')+'</small></div>';
}
function recentTurnCell(label,html,cls=''){return '<td data-label="'+attr(label)+'"'+(cls?' class="'+cls+'"':'')+'>'+html+'</td>'}
function recentTurnAgeHtml(e){return '<span class="activity-age" data-activity-age-at="'+attr(e.timestamp||'')+'" title="'+attr(fmtDate(e.timestamp))+'">'+esc(fmtRelativeAgo(e.timestamp))+'</span>'}
function recentTurnStatusClass(status){if(status==='failed'||status==='aborted')return'error';if(status==='queued'||status==='running')return'warn';return''}
function recentTurnActorText(e){const a=e.actor||{};return a.label||a.username||a.id||e.actorId||({web:'Web user',telegram:'Telegram user',discord:'Discord user',slack:'Slack user',cli:'CLI',system:'System'}[a.channel]||'System')}
function recentTurnContextHtml(e){const workspace=e.workspace||'';const parts=[];if(e.agentId)parts.push('<span class="truncate-cell" title="'+attr(e.agentId)+'">'+esc(e.agentId)+'</span>');if(e.threadId)parts.push('<button type="button" class="copy-id" data-copy-value="'+attr(e.threadId)+'" data-copy-label="Thread ID copied" title="'+attr(e.threadId)+'">'+esc(shortMiddle(e.threadId))+'</button>');if(workspace)parts.push('<span class="truncate-cell" title="'+attr(workspace)+'">'+esc(short(workspace,120))+'</span>');if(typeof e.durationMs==='number')parts.push('<span>'+esc(fmtDuration(e.durationMs))+'</span>');if(e.correlationId)parts.push('<span>CID '+uiCopyButton(e.correlationId,'Correlation ID copied')+'</span>');return parts.length?'<div class="activity-context">'+parts.join('')+'</div>':'-'}
function renderRecentTurnRow(e){const type=[e.category,e.type].filter(Boolean).join(' / ')||'-';const detail=e.prompt||e.detail||'';const status='<span class="chip '+recentTurnStatusClass(e.status)+'">'+esc(e.status||'-')+'</span>';const actions=e.correlationId?'<div class="data-table-actions"><button type="button" class="secondary" data-trace-id="'+attr(e.correlationId)+'">Trace</button></div>':'-';return '<tr>'+recentTurnCell('Time',recentTurnAgeHtml(e),'updated-cell')+recentTurnCell('Source',esc(e.source||'-'))+recentTurnCell('Status',status,'status-cell')+recentTurnCell('Type','<span class="truncate-cell" title="'+attr(type)+'">'+esc(short(type,80))+'</span>','type-cell')+recentTurnCell('User','<span class="truncate-cell" title="'+attr(recentTurnActorText(e))+'">'+esc(short(recentTurnActorText(e),80))+'</span>','user-cell')+recentTurnCell('Context',recentTurnContextHtml(e),'context-cell')+recentTurnCell('Detail','<span class="truncate-cell" title="'+attr(detail)+'">'+esc(short(detail||'-',220))+'</span>','detail-cell')+recentTurnCell('Actions',actions,'actions-cell')+'</tr>'}
function renderRecentTurnsTable(turns){if(!turns.length)return uiEmpty('No recent tasks.');return '<div class="data-table-wrap"><table class="data-table activity-table recent-turns-table"><thead><tr><th>Time</th><th>Source</th><th>Status</th><th>Type</th><th>User</th><th>Context</th><th>Detail</th><th class="actions-heading">Actions</th></tr></thead><tbody>'+turns.map(renderRecentTurnRow).join('')+'</tbody></table></div>'}
function renderTasks(d,jobs){
  const target=document.getElementById('tasksList');
  target.innerHTML='<div class="task-grid">'+taskCard(d.current,'Current web turn')+taskCard(d.external,'External CLI turn')+'</div><h2 class="task-section-title">Unified jobs</h2><div class="list">'+renderUnifiedJobs(jobs?.jobs||[])+'</div><h2 class="task-section-title">Queue</h2><div class="list">'+((d.queue||[]).map(q=>'<div class="item"><strong>'+esc(q.id+' · '+q.description)+'</strong><small>'+esc(fmtDate(q.createdAt)+' / attempts '+q.attempts)+(q.correlationId?' / '+uiTraceControls(q.correlationId):'')+'</small><div class="row"><button data-q="run" data-id="'+attr(q.id)+'"'+disabledAttr('queue.write')+'>Run</button><button data-q="cancel" data-id="'+attr(q.id)+'" class="danger"'+disabledAttr('queue.write')+'>Cancel</button></div></div>').join('')||uiEmpty('Queue is empty.'))+'</div><h2 class="task-section-title">Recent turns</h2>'+renderRecentTurnsTable(d.recent||[]);
  bindUiCopyButtons(target);
  bindUiTraceButtons(target);
  startActivityAgeCounter();
  document.querySelectorAll('#tasksList [data-q]').forEach(b=>b.onclick=()=>safe(async()=>{if(!can('queue.write')){toast('Permission required: queue.write');return}const r=await api('/api/queue',{method:'POST',body:JSON.stringify({action:b.dataset.q,id:b.dataset.id})});renderQueue(r.queue,r.paused);loadTasks()}));
  bindUnifiedJobButtons();
  applyPermissions();
}
function renderUnifiedJobs(jobs){
  return jobs.map(job=>{const retryPermission=jobActionPermission(job,'retry');const cancelPermission=jobActionPermission(job,'cancel');return '<div class="item"><strong>'+esc(job.title)+' <span class="adapter-status '+esc(jobStatusClass(job.status))+'">'+esc(job.status)+'</span></strong><small>'+esc([job.kind,job.source,job.agentLabel||job.agentId,fmtDate(job.startedAt)].filter(Boolean).join(' / '))+'</small>'+(job.correlationId?'<small>'+uiTraceControls(job.correlationId)+'</small>':'')+(job.owner?'<small>'+esc('Owner: '+(job.owner.label||job.owner.username||job.owner.id||'-'))+'</small>':'')+(job.threadId?'<small>'+esc('Thread: '+job.threadId)+'</small>':'')+(job.summary?'<small>'+esc(short(job.summary,300))+'</small>':'')+(job.logTail?'<pre class="update-log">'+esc(short(job.logTail,1200))+'</pre>':'')+'<div class="row">'+(job.canReadLog?'<button class="secondary" data-job-log="'+attr(job.id)+'">Log</button>':'')+(job.canRetry?'<button class="secondary" data-job-action="retry" data-job-permission="'+attr(retryPermission)+'" data-job-id="'+attr(job.id)+'"'+disabledAttr(retryPermission)+'>Retry</button>':'')+(job.canCancel?'<button class="danger" data-job-action="cancel" data-job-permission="'+attr(cancelPermission)+'" data-job-id="'+attr(job.id)+'"'+disabledAttr(cancelPermission)+'>Cancel</button>':'')+'</div></div>'}).join('')||uiEmpty('No jobs.');
}
function jobActionPermission(job,action){
  if(job.id==='web:current'&&action==='cancel')return'prompt.abort';
  if(String(job.id||'').startsWith('queue:'))return'queue.write';
  if(String(job.id||'').startsWith('workflow-run:'))return'workflows.run';
  if(String(job.id||'').startsWith('support-bundle:'))return'diagnostics.read';
  return'updates.run';
}
function bindUnifiedJobButtons(){
  document.querySelectorAll('[data-job-log]').forEach(b=>b.onclick=()=>safe(async()=>{const r=await api('/api/jobs/'+encodeURIComponent(b.dataset.jobLog)+'/log');toast((r.plain||'No log').slice(0,3500),{duration:12000})}));
  document.querySelectorAll('[data-job-action]').forEach(b=>b.onclick=()=>safe(async()=>{const permission=b.dataset.jobPermission||'updates.run';if(!can(permission)){toast('Permission required: '+permission);return}const action=b.dataset.jobAction;if(confirm((action==='cancel'?'Cancel':'Retry')+' job '+b.dataset.jobId+'?')){await api('/api/jobs/'+encodeURIComponent(b.dataset.jobId)+'/action',{method:'POST',body:JSON.stringify({action})});toast('Job '+action+' requested');loadTasks()}}));
}
document.getElementById('reloadTasksBtn').onclick=()=>loadTasks(true);
