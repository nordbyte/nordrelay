function scrollChatToBottom(){const box=document.getElementById('messages');if(!box)return;requestAnimationFrame(()=>{box.scrollTop=box.scrollHeight;requestAnimationFrame(()=>{box.scrollTop=box.scrollHeight})})}
function appendMessage(cls,text){const box=document.getElementById('messages');const div=document.createElement('div');div.className='message '+cls;div.textContent=text;box.appendChild(div);scrollChatToBottom();return div}
function appendQueuedMessage(id){const div=appendMessage('system','Queued prompt '+id);const btn=document.createElement('button');btn.textContent='Cancel queued message';btn.className='danger';btn.onclick=()=>safe(async()=>{const r=await api('/api/queue',{method:'POST',body:JSON.stringify({action:'cancel',id})});renderQueue(r.queue,r.paused);div.textContent='Cancelled queued prompt '+id});div.appendChild(document.createElement('br'));div.appendChild(btn)}
function renderChatMessages(messages){state.chatMessages=messages||[];const box=document.getElementById('messages');box.innerHTML=(messages||[]).map(m=>'<div class="message '+esc(m.role)+'"><small>'+esc((m.source||'web')+' / '+fmtDate(m.timestamp))+'</small>\\n'+esc(m.text)+'</div>').join('');scrollChatToBottom()}
async function loadChatHistory(){const data=await api('/api/chat/history');renderChatMessages(data.messages||[])}
let currentAgentMessage=null;
function connectEvents(){
  if(state.events) state.events.close();
  const eventsUrl = state.selectedPeer && state.selectedPeer !== 'local'
    ? '/api/peers/'+encodeURIComponent(state.selectedPeer)+'/events'
    : '/api/events';
  const events = new EventSource(eventsUrl);
  state.events=events;
  setConnection('Connecting','warn');
  events.onopen=()=>{if(state.reconnectTimer){clearTimeout(state.reconnectTimer);state.reconnectTimer=null}setConnection('Live','ok')};
  events.addEventListener('snapshot', e=>{const d=JSON.parse(e.data).data;state.snapshot=d;renderSnapshot(d);renderSessionControls()});
  events.addEventListener('chat_history', e=>renderChatMessages(JSON.parse(e.data).messages||[]));
  events.addEventListener('activity_update', e=>renderActivity(JSON.parse(e.data).events||[]));
  events.addEventListener('active_sessions_update', e=>{const d=JSON.parse(e.data);state.activeSessions=d.active||null;if(state.currentPage==='overview')renderActiveSessions(state.activeSessions?.sessions||[])});
  events.addEventListener('session_update', e=>{loadBootstrap();loadChatHistory()});
  events.addEventListener('agent_update', e=>{const d=JSON.parse(e.data);upsertAgentUpdateJob(d.job);if(state.currentPage==='version'){renderAgentUpdateJobs();if(d.job&&d.job.status!=='running')setTimeout(loadVersion,800)}});
  events.addEventListener('queue_update', e=>{const d=JSON.parse(e.data);renderQueue(d.queue,d.paused)});
  events.addEventListener('turn_start', e=>{const d=JSON.parse(e.data);appendMessage('user',d.prompt);currentAgentMessage=appendMessage('agent','');if(state.currentPage==='tasks')loadTasks()});
  events.addEventListener('text_delta', e=>{const d=JSON.parse(e.data);if(!currentAgentMessage)currentAgentMessage=appendMessage('agent','');currentAgentMessage.textContent+=d.delta;scrollChatToBottom();if(state.currentPage==='tasks')loadTasks()});
  events.addEventListener('tool_start', e=>{const d=JSON.parse(e.data);tool('tool','Started '+d.toolName);if(state.currentPage==='tasks')loadTasks()});
  events.addEventListener('tool_update', e=>{const d=JSON.parse(e.data);if(d.partialResult)tool('tool',d.partialResult.slice(-600))});
  events.addEventListener('tool_end', e=>{const d=JSON.parse(e.data);tool(d.isError?'danger':'tool','Finished '+d.toolCallId+(d.isError?' with error':''))});
  events.addEventListener('todo_update', e=>{const d=JSON.parse(e.data);tool('tool','Plan:\\n'+d.items.map(i=>(i.completed?'[x] ':'[ ] ')+i.text).join('\\n'))});
  events.addEventListener('turn_error', e=>{const d=JSON.parse(e.data);appendMessage('system','Error: '+d.error);currentAgentMessage=null});
  events.addEventListener('turn_complete', ()=>{currentAgentMessage=null;notify('NordRelay turn finished','The active task completed.');loadBootstrap();if(state.currentPage==='tasks')loadTasks()});
  events.addEventListener('status', e=>{const d=JSON.parse(e.data);const msg=d.message||'';if(isCliRunningStatus(msg)){state.cliStatusActive=true;toast(msg,{sticky:true});return}if(isCliDoneStatus(msg))state.cliStatusActive=false;toast(msg)});
  events.onerror=()=>{setConnection('Reconnecting','error');if(!state.reconnectTimer)state.reconnectTimer=setTimeout(()=>{state.reconnectTimer=null;connectEvents()},5000)};
}
function setConnection(text,kind){const el=document.getElementById('connectionStatus');el.textContent=text;el.className='badge connection-'+kind}
async function enableNotifications(){if(!('Notification' in window)){toast('Browser notifications are not supported');return}const permission=Notification.permission==='granted'?'granted':await Notification.requestPermission();state.notifications=permission==='granted';toast(state.notifications?'Browser notifications enabled':'Browser notifications denied')}
function notify(title,body){if(state.notifications&&'Notification' in window&&Notification.permission==='granted')new Notification(title,{body})}
function toolAgeText(el){const created=Number(el.dataset.createdAt||Date.now());return 'Updated '+fmtAge(Date.now()-created)}
function refreshToolTooltip(){const tip=document.getElementById('toolTooltip');if(tip&&state.toolTooltipTarget)tip.textContent=toolAgeText(state.toolTooltipTarget)}
function positionToolTooltip(event){const tip=document.getElementById('toolTooltip');if(!tip||tip.style.display==='none')return;const gap=12;const rect=tip.getBoundingClientRect();let x=event.clientX+gap;let y=event.clientY+gap;if(x+rect.width>window.innerWidth-8)x=event.clientX-rect.width-gap;if(y+rect.height>window.innerHeight-8)y=event.clientY-rect.height-gap;tip.style.left=Math.max(8,x)+'px';tip.style.top=Math.max(8,y)+'px'}
function showToolTooltip(target,event){state.toolTooltipTarget=target;const tip=document.getElementById('toolTooltip');if(!tip)return;refreshToolTooltip();tip.style.display='block';positionToolTooltip(event);if(state.toolTooltipTimer)clearInterval(state.toolTooltipTimer);state.toolTooltipTimer=setInterval(refreshToolTooltip,1000)}
function hideToolTooltip(){const tip=document.getElementById('toolTooltip');if(tip)tip.style.display='none';state.toolTooltipTarget=null;if(state.toolTooltipTimer)clearInterval(state.toolTooltipTimer);state.toolTooltipTimer=null}
function updateToolAgeTitles(){document.querySelectorAll('.tool[data-created-at]').forEach(el=>el.setAttribute('aria-label',toolAgeText(el)))}
const toolStreamEl=document.getElementById('toolStream');
toolStreamEl.addEventListener('mouseover',e=>{const target=e.target.closest?.('.tool[data-created-at]');if(target&&target!==state.toolTooltipTarget)showToolTooltip(target,e)});
toolStreamEl.addEventListener('mousemove',e=>positionToolTooltip(e));
toolStreamEl.addEventListener('mouseout',e=>{const target=e.target.closest?.('.tool[data-created-at]');if(target&&!target.contains(e.relatedTarget))hideToolTooltip()});
toolStreamEl.addEventListener('focusin',e=>{const target=e.target.closest?.('.tool[data-created-at]');if(target)showToolTooltip(target,{clientX:target.getBoundingClientRect().left,clientY:target.getBoundingClientRect().bottom})});
toolStreamEl.addEventListener('focusout',hideToolTooltip);
function tool(cls,text){const div=document.createElement('div');div.className='tool '+(cls==='danger'?'danger':'');div.dataset.createdAt=String(Date.now());div.tabIndex=0;div.textContent=text;document.getElementById('toolStream').prepend(div);updateToolAgeTitles()}
setInterval(updateToolAgeTitles,30000);
