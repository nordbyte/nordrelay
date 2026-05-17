const QUEUE_PLAN_COLUMNS=[
  ['draft','Draft'],
  ['review','Review'],
  ['approved','Approved'],
  ['queued','Queued'],
  ['in_progress','In Progress'],
  ['done','Done'],
  ['failed','Failed'],
  ['aborted','Aborted'],
  ['archived','Archived'],
];

function switchQueueTab(tab){
  state.queueTab=tab||'queue';
  document.querySelectorAll('[data-queue-tab]').forEach(b=>{
    const active=b.dataset.queueTab===state.queueTab;
    b.classList.toggle('active',active);
    b.setAttribute('aria-selected',active?'true':'false');
    b.tabIndex=active?0:-1;
  });
  document.querySelectorAll('[data-queue-tab-panel]').forEach(panel=>panel.classList.toggle('active',panel.dataset.queueTabPanel===state.queueTab));
}

function bindQueueTabs(){
  document.querySelectorAll('[data-queue-tab]').forEach(b=>{
    if(b.dataset.bound)return;
    b.dataset.bound='true';
    b.onclick=()=>switchQueueTab(b.dataset.queueTab);
  });
}

async function loadQueue(){
  bindQueueTabs();
  switchQueueTab(state.queueTab||'queue');
  if(!can('queue.read')){
    document.getElementById('queueList').innerHTML=uiEmpty('Permission required: queue.read');
    return;
  }
  setLoading('queueList','Loading queue...');
  if(can('queue.plan.read')){
    setLoading('queuePlannerBoard','Loading planned prompts...');
    setLoading('queueProgressBoard','Loading in-progress prompts...');
  }
  const [queue,planner]=await Promise.all([
    api('/api/queue'),
    can('queue.plan.read')?api('/api/queue/plans'):Promise.resolve(null),
  ]);
  renderQueue(queue.queue,queue.paused);
  if(planner)renderQueuePlanner(planner);
}

async function loadQueuePlanner(options={}){
  if(!can('queue.plan.read'))return;
  setLoading('queuePlannerBoard','Loading planned prompts...');
  setLoading('queueProgressBoard','Loading in-progress prompts...');
  const planner=await api('/api/queue/plans');
  renderQueuePlanner(planner);
  if(options.notify)toast('Planner reloaded');
}

function renderQueuePlanner(data){
  state.queuePlanner=data;
  renderQueueKanban(data);
  renderQueueProgress(data);
  applyPermissions();
}

function queuePlanMatches(plan){
  const q=(document.getElementById('queuePlanSearch')?.value||'').trim().toLowerCase();
  if(!q)return true;
  return [plan.title,plan.prompt,plan.id,plan.agentId,plan.workspace,plan.threadId,(plan.labels||[]).join(' ')].join(' ').toLowerCase().includes(q);
}

function renderQueueKanban(data){
  const target=document.getElementById('queuePlannerBoard');
  if(!target)return;
  if(!can('queue.plan.read')){target.innerHTML=uiEmpty('Permission required: queue.plan.read');return}
  const columns=data.columns||{};
  target.innerHTML=QUEUE_PLAN_COLUMNS.map(([status,label])=>{
    const items=(columns[status]||[]).filter(queuePlanMatches);
    return '<div class="queue-kanban-column" data-plan-drop="'+attr(status)+'"><h3><span>'+esc(label)+'</span><span>'+items.length+'</span></h3><div class="list">'+(items.map(queuePlanCard).join('')||uiEmpty('No prompts.'))+'</div></div>';
  }).join('');
  bindQueuePlanButtons(target);
  bindQueuePlanDrag(target);
  bindUiCopyButtons(target);
  bindUiTraceButtons(target);
}

function renderQueueProgress(data){
  const target=document.getElementById('queueProgressBoard');
  if(!target)return;
  if(!can('queue.plan.read')){target.innerHTML=uiEmpty('Permission required: queue.plan.read');return}
  const planned=(data.columns?.in_progress||[]).map(queuePlanCard).join('');
  const runtime=(data.inProgress||[]).map(task=>'<div class="item queue-plan-card"><strong>'+esc(task.agentLabel||task.agentId||'Agent')+' '+uiBadge(task.status,task.status==='failed'?'disabled':'planned')+'</strong><small>'+esc(short(task.prompt||task.detail||'Running prompt',220))+'</small><small>'+esc([task.source,task.threadId||'pending',task.workspace,fmtDuration(task.durationMs)].filter(Boolean).join(' | '))+'</small>'+(task.correlationId?'<small>'+uiTraceControls(task.correlationId)+'</small>':'')+'</div>').join('');
  target.innerHTML='<div class="queue-kanban-column"><h3><span>Planned prompts</span><span>'+((data.columns?.in_progress||[]).length)+'</span></h3><div class="list">'+(planned||uiEmpty('No planned prompt is running.'))+'</div></div>'+
    '<div class="queue-kanban-column"><h3><span>Runtime activity</span><span>'+((data.inProgress||[]).length)+'</span></h3><div class="list">'+(runtime||uiEmpty('No runtime task is currently running.'))+'</div></div>';
  bindQueuePlanButtons(target);
  bindUiCopyButtons(target);
  bindUiTraceButtons(target);
}

function queuePlanCard(plan){
  const badge=uiBadge(queuePlanStatusLabel(plan.effectiveStatus||plan.status),queuePlanStatusClass(plan.effectiveStatus||plan.status));
  const labels=(plan.labels||[]).map(label=>'<span class="chip">'+esc(label)+'</span>').join('');
  const queue=plan.queueId?'<span class="chip">Queue '+esc(plan.queuePosition?('#'+plan.queuePosition):plan.queueId)+'</span>':'';
  const meta=[plan.agentId,plan.workspace,plan.threadId?('Thread '+short(plan.threadId,18)):'',plan.priority?('P'+plan.priority):''].filter(Boolean);
  const actions=[
    '<button type="button" class="secondary" data-plan-edit="'+attr(plan.id)+'"'+disabledAttr('queue.plan.write')+'>Edit</button>',
    plan.effectiveStatus==='draft'?'<button type="button" class="secondary" data-plan-move="'+attr(plan.id)+'" data-plan-status="review"'+disabledAttr('queue.plan.write')+'>Review</button>':'',
    plan.effectiveStatus==='review'?'<button type="button" data-plan-approve="'+attr(plan.id)+'"'+disabledAttr('queue.plan.approve')+'>Approve</button>':'',
    plan.effectiveStatus==='approved'?'<button type="button" data-plan-enqueue="'+attr(plan.id)+'"'+disabledAttr('queue.plan.approve')+'>Send to queue</button>':'',
    plan.effectiveStatus==='queued'&&plan.queueId?'<button type="button" class="secondary" data-q="run" data-id="'+attr(plan.queueId)+'"'+disabledAttr('queue.write')+'>Run next</button><button type="button" class="danger" data-q="cancel" data-id="'+attr(plan.queueId)+'"'+disabledAttr('queue.write')+'>Cancel</button>':'',
    plan.correlationId?'<button type="button" class="secondary mini-button" data-trace-id="'+attr(plan.correlationId)+'">Trace</button>':'',
    '<button type="button" class="danger" data-plan-delete="'+attr(plan.id)+'"'+disabledAttr('queue.plan.write')+'>Delete</button>',
  ].filter(Boolean).join('');
  return '<div class="item queue-plan-card" draggable="'+(['draft','review','approved','archived'].includes(plan.effectiveStatus)?'true':'false')+'" data-plan-id="'+attr(plan.id)+'"><strong>'+esc(plan.title)+' '+badge+'</strong><small>'+esc(short(plan.prompt,260))+'</small><small>'+esc(meta.join(' | ')||'Current session')+'</small><div class="queue-plan-meta">'+labels+queue+(plan.correlationId?'<span class="chip">CID '+esc(plan.correlationId)+'</span>':'')+'</div><div class="row">'+actions+'</div></div>';
}

function queuePlanStatusLabel(status){return String(status||'draft').replace('_',' ')}
function queuePlanStatusClass(status){if(status==='done')return'enabled';if(status==='failed'||status==='aborted'||status==='archived')return'disabled';if(status==='queued'||status==='in_progress')return'planned';return'planned'}

function bindQueuePlanButtons(root=document){
  root.querySelectorAll('[data-plan-edit]').forEach(b=>b.onclick=()=>openQueuePlanDialog((state.queuePlanner?.plans||[]).find(p=>p.id===b.dataset.planEdit)));
  root.querySelectorAll('[data-plan-delete]').forEach(b=>b.onclick=()=>safe(async()=>{if(!can('queue.plan.write')){toast('Permission required: queue.plan.write');return}if(confirm('Delete planned prompt '+b.dataset.planDelete+'?')){const r=await api('/api/queue/plans/'+encodeURIComponent(b.dataset.planDelete),{method:'DELETE'});renderQueuePlanner(r.snapshot);toast(r.removed?'Plan deleted':'Plan not found')}}));
  root.querySelectorAll('[data-plan-move]').forEach(b=>b.onclick=()=>safe(()=>moveQueuePlan(b.dataset.planMove,b.dataset.planStatus)));
  root.querySelectorAll('[data-plan-approve]').forEach(b=>b.onclick=()=>safe(()=>approveQueuePlan(b.dataset.planApprove)));
  root.querySelectorAll('[data-plan-enqueue]').forEach(b=>b.onclick=()=>safe(()=>enqueueQueuePlan(b.dataset.planEnqueue)));
  root.querySelectorAll('[data-q]').forEach(b=>b.onclick=()=>safe(async()=>{if(!can('queue.write')){toast('Permission required: queue.write');return}const r=await api('/api/queue',{method:'POST',body:JSON.stringify({action:b.dataset.q,id:b.dataset.id})});renderQueue(r.queue,r.paused);await loadQueuePlanner()}));
}

function bindQueuePlanDrag(root=document){
  let dragged=null;
  root.querySelectorAll('[data-plan-id]').forEach(card=>{
    card.ondragstart=()=>{if(!can('queue.plan.write'))return;dragged=card.dataset.planId;card.classList.add('dragging')};
    card.ondragend=()=>card.classList.remove('dragging');
  });
  root.querySelectorAll('[data-plan-drop]').forEach(column=>{
    column.ondragover=e=>{if(can('queue.plan.write')){e.preventDefault();column.classList.add('drag-over')}};
    column.ondragleave=()=>column.classList.remove('drag-over');
    column.ondrop=e=>safe(async()=>{e.preventDefault();column.classList.remove('drag-over');if(!dragged)return;await moveQueuePlan(dragged,column.dataset.planDrop)});
  });
}

async function moveQueuePlan(id,status){
  if(status==='queued')return enqueueQueuePlan(id);
  if(['in_progress','done','failed','aborted'].includes(status)){toast('Runtime statuses are updated automatically');return}
  if(!can('queue.plan.write')){toast('Permission required: queue.plan.write');return}
  const r=await api('/api/queue/plans/'+encodeURIComponent(id)+'/move',{method:'POST',body:JSON.stringify({status})});
  renderQueuePlanner(r.snapshot);
  toast('Plan moved to '+queuePlanStatusLabel(status));
}

async function approveQueuePlan(id){
  if(!can('queue.plan.approve')){toast('Permission required: queue.plan.approve');return}
  const r=await api('/api/queue/plans/'+encodeURIComponent(id)+'/approve',{method:'POST'});
  renderQueuePlanner(r.snapshot);
  toast('Plan approved');
}

async function enqueueQueuePlan(id){
  if(!can('queue.plan.approve')){toast('Permission required: queue.plan.approve');return}
  const r=await api('/api/queue/plans/'+encodeURIComponent(id)+'/enqueue',{method:'POST'});
  renderQueuePlanner(r.snapshot);
  renderQueue(r.snapshot.queue,r.snapshot.paused);
  toast('Plan sent to runtime queue');
}

function openQueuePlanDialog(plan){
  if(!can('queue.plan.write')){toast('Permission required: queue.plan.write');return}
  const session=state.snapshot?.session||{};
  const agentOptions=(state.enabledAgents||[]).map(id=>'<option value="'+attr(id)+'" '+(id===(plan?.agentId||session.agentId)?'selected':'')+'>'+esc(id)+'</option>').join('');
  const workspaceOptions=(state.controls?.workspaces||state.snapshot?.workspaces||[]).map(w=>'<option value="'+attr(w)+'"></option>').join('');
  adminDialog(plan?'Edit planned prompt':'Create planned prompt','<label>Title<input id="dlgQueuePlanTitle" value="'+attr(plan?.title||'')+'" placeholder="Short title"></label><label>Priority<input id="dlgQueuePlanPriority" type="number" min="0" max="100" value="'+attr(plan?.priority??0)+'"></label><label>Agent<select id="dlgQueuePlanAgent">'+agentOptions+'</select></label><label>Workspace<input id="dlgQueuePlanWorkspace" list="queuePlanWorkspaceOptions" value="'+attr(plan?.workspace||session.workspace||'')+'"><datalist id="queuePlanWorkspaceOptions">'+workspaceOptions+'</datalist></label><label class="full-span">Thread ID<input id="dlgQueuePlanThread" value="'+attr(plan?.threadId||session.threadId||'')+'" placeholder="Current thread by default"></label><label class="full-span">Labels<input id="dlgQueuePlanLabels" value="'+attr((plan?.labels||[]).join(', '))+'" placeholder="review, release, docs"></label><label class="full-span">Prompt<textarea id="dlgQueuePlanPrompt" rows="10" placeholder="Write the planned prompt...">'+esc(plan?.prompt||'')+'</textarea></label>',async()=>{
    const body={title:val('dlgQueuePlanTitle'),priority:Number(val('dlgQueuePlanPriority')||0),agentId:val('dlgQueuePlanAgent')||undefined,workspace:val('dlgQueuePlanWorkspace')||undefined,threadId:val('dlgQueuePlanThread')||undefined,labels:csvToList(val('dlgQueuePlanLabels')),prompt:val('dlgQueuePlanPrompt')};
    const r=plan?await api('/api/queue/plans/'+encodeURIComponent(plan.id),{method:'PATCH',body:JSON.stringify(body)}):await api('/api/queue/plans',{method:'POST',body:JSON.stringify(body)});
    renderQueuePlanner(r.snapshot);
    toast(plan?'Plan updated':'Plan created');
  },{submitText:plan?'Save plan':'Create plan',reloadAccess:false});
}

document.getElementById('createQueuePlanBtn').onclick=()=>openQueuePlanDialog();
document.getElementById('reloadQueuePlansBtn').onclick=()=>safe(()=>loadQueuePlanner({notify:true}));
document.getElementById('reloadQueueProgressBtn').onclick=()=>safe(()=>loadQueuePlanner({notify:true}));
document.getElementById('queuePlanSearch').oninput=()=>{if(state.queuePlanner)renderQueueKanban(state.queuePlanner)};
bindQueueTabs();
