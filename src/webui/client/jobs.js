async function loadTasks(){
  setLoading('tasksList','Loading tasks...');
  const [d,jobs]=await Promise.all([api('/api/tasks'),api('/api/jobs')]);
  renderTasks(d,jobs);
}
function taskCard(t,title){
  if(!t)return '<div class="item"><strong>'+esc(title)+'</strong><small>Idle</small></div>';
  const tools=(t.tools||[]).map(x=>x.name+' x'+x.count).join(', ')||'-';
  return '<div class="item"><strong>'+esc(title+' · '+t.status)+'</strong><small>'+esc((t.agentLabel||t.agentId||t.source)+' / '+(t.threadId||'-'))+'</small><small>'+esc('Elapsed '+fmtDuration(t.durationMs)+' / current '+(t.currentTool||'-')+' / last '+(t.lastTool||'-'))+'</small><small>'+esc('Tools: '+tools+' / output chars '+(t.outputChars||0))+'</small><small>'+esc(t.prompt||t.detail||'')+'</small></div>';
}
function renderTasks(d,jobs){
  document.getElementById('tasksList').innerHTML='<div class="task-grid">'+taskCard(d.current,'Current web turn')+taskCard(d.external,'External CLI turn')+'</div><h2 class="task-section-title">Unified jobs</h2><div class="list">'+renderUnifiedJobs(jobs?.jobs||[])+'</div><h2 class="task-section-title">Queue</h2><div class="list">'+((d.queue||[]).map(q=>'<div class="item"><strong>'+esc(q.id+' · '+q.description)+'</strong><small>'+esc(fmtDate(q.createdAt)+' / attempts '+q.attempts)+'</small><div class="row"><button data-q="run" data-id="'+attr(q.id)+'"'+disabledAttr('queue.write')+'>Run</button><button data-q="cancel" data-id="'+attr(q.id)+'" class="danger"'+disabledAttr('queue.write')+'>Cancel</button></div></div>').join('')||'<div class="item">Queue is empty.</div>')+'</div><h2 class="task-section-title">Recent turns</h2><div class="list">'+((d.recent||[]).map(e=>'<div class="item"><strong>'+esc(e.status+' / '+e.source+' / '+e.type)+'</strong><small>'+esc(fmtDate(e.timestamp)+' / '+(e.threadId||'-'))+'</small><small>'+esc(short(e.prompt||e.detail||'',300))+'</small></div>').join('')||'<div class="item">No recent tasks.</div>')+'</div>';
  document.querySelectorAll('#tasksList [data-q]').forEach(b=>b.onclick=()=>safe(async()=>{if(!can('queue.write')){toast('Permission required: queue.write');return}const r=await api('/api/queue',{method:'POST',body:JSON.stringify({action:b.dataset.q,id:b.dataset.id})});renderQueue(r.queue,r.paused);loadTasks()}));
  bindUnifiedJobButtons();
  applyPermissions();
}
function renderUnifiedJobs(jobs){
  return jobs.map(job=>{const retryPermission=jobActionPermission(job,'retry');const cancelPermission=jobActionPermission(job,'cancel');return '<div class="item"><strong>'+esc(job.title)+' <span class="adapter-status '+esc(jobStatusClass(job.status))+'">'+esc(job.status)+'</span></strong><small>'+esc([job.kind,job.source,job.agentLabel||job.agentId,fmtDate(job.startedAt)].filter(Boolean).join(' / '))+'</small>'+(job.owner?'<small>'+esc('Owner: '+(job.owner.label||job.owner.username||job.owner.id||'-'))+'</small>':'')+(job.threadId?'<small>'+esc('Thread: '+job.threadId)+'</small>':'')+(job.summary?'<small>'+esc(short(job.summary,300))+'</small>':'')+(job.logTail?'<pre class="update-log">'+esc(short(job.logTail,1200))+'</pre>':'')+'<div class="row">'+(job.canReadLog?'<button class="secondary" data-job-log="'+attr(job.id)+'">Log</button>':'')+(job.canRetry?'<button class="secondary" data-job-action="retry" data-job-permission="'+attr(retryPermission)+'" data-job-id="'+attr(job.id)+'"'+disabledAttr(retryPermission)+'>Retry</button>':'')+(job.canCancel?'<button class="danger" data-job-action="cancel" data-job-permission="'+attr(cancelPermission)+'" data-job-id="'+attr(job.id)+'"'+disabledAttr(cancelPermission)+'>Cancel</button>':'')+'</div></div>'}).join('')||'<div class="item">No jobs.</div>';
}
function jobActionPermission(job,action){
  if(job.id==='web:current'&&action==='cancel')return'prompt.abort';
  if(String(job.id||'').startsWith('queue:'))return'queue.write';
  if(String(job.id||'').startsWith('support-bundle:'))return'diagnostics.read';
  return'updates.run';
}
function bindUnifiedJobButtons(){
  document.querySelectorAll('[data-job-log]').forEach(b=>b.onclick=()=>safe(async()=>{const r=await api('/api/jobs/'+encodeURIComponent(b.dataset.jobLog)+'/log');toast((r.plain||'No log').slice(0,3500),{duration:12000})}));
  document.querySelectorAll('[data-job-action]').forEach(b=>b.onclick=()=>safe(async()=>{const permission=b.dataset.jobPermission||'updates.run';if(!can(permission)){toast('Permission required: '+permission);return}const action=b.dataset.jobAction;if(confirm((action==='cancel'?'Cancel':'Retry')+' job '+b.dataset.jobId+'?')){await api('/api/jobs/'+encodeURIComponent(b.dataset.jobId)+'/action',{method:'POST',body:JSON.stringify({action})});toast('Job '+action+' requested');loadTasks()}}));
}
document.getElementById('reloadTasksBtn').onclick=()=>loadTasks();
