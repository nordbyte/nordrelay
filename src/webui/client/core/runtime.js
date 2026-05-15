const state = { snapshot:null, controls:null, newSessionControls:null, enabledAgents:[], auth:null, permissions:[], settings:[], currentPage:'overview', settingsGroup:null, accessTab:'users', logsPlain:'', logTimer:null, toastTimer:null, cliStatusActive:false, selectedArtifactTurns:new Set(), mediaRecorder:null, recordedChunks:[], events:null, reconnectTimer:null, notifications:false, toolTooltipTimer:null, toolTooltipTarget:null, agentUpdateJobs:[], sessionsRequestId:0, activeSessions:null };
function toast(msg,options={}){const el=document.getElementById('toast');el.textContent=msg;el.style.display='block';if(state.toastTimer)clearTimeout(state.toastTimer);state.toastTimer=null;if(!options.sticky){state.toastTimer=setTimeout(()=>{el.style.display='none';state.toastTimer=null},options.duration||3500)}}
function esc(s){return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function attr(s){return esc(s).replace(/"/g,'&quot;')}
function cssEscape(s){return window.CSS&&CSS.escape?CSS.escape(s):String(s).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&')}
function short(s,max=250){const text=String(s??'');return text.length>max?text.slice(0,max-1)+'...':text}
async function copyText(text,label='Copied'){if(!text)return;try{await navigator.clipboard.writeText(text)}catch{const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();document.execCommand('copy');area.remove()}toast(label)}
function fmtDate(s){return s?new Date(s).toLocaleString(): '-'}
function fmtDuration(ms){if(!ms&&ms!==0)return '-';const sec=Math.round(ms/1000);if(sec<60)return sec+'s';return Math.floor(sec/60)+'m '+(sec%60)+'s'}
function fmtBytes(n){if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1).replace(/\\.0$/,'')+' KB';return (n/1048576).toFixed(1).replace(/\\.0$/,'')+' MB'}
function compactNum(n){if(!n)return'';if(n>=1000000000)return Math.round(n/100000000)/10+'B';if(n>=1000000)return Math.round(n/100000)/10+'M';if(n>=1000)return Math.round(n/100)/10+'K';return String(n)}
function loadingHtml(label){return '<div class="loading-state"><span class="spinner"></span><span>'+esc(label||'Loading...')+'</span></div>'}
function setLoading(id,label){const el=document.getElementById(id);if(el)el.innerHTML=loadingHtml(label)}
function can(permission){return !permission || (state.permissions||[]).includes(permission)}
function disabledAttr(permission){return can(permission)?'':' disabled title="Permission required: '+attr(permission)+'"'}
function hiddenStyle(permission){return can(permission)?'':' style="display:none"'}
function applyPermissions(){
  document.querySelectorAll('[data-permission]').forEach(el=>{const allowed=can(el.dataset.permission);el.hidden=!allowed;el.disabled=!allowed});
  const currentButton=document.querySelector('nav button[data-page="'+cssEscape(state.currentPage)+'"]');
  if(currentButton&&currentButton.hidden){const first=[...document.querySelectorAll('nav button[data-page]')].find(b=>!b.hidden);if(first)page(first.dataset.page)}
  const disableMap=[
    ['#promptForm > button,#promptInput','prompt.send'],
    ['#fileInput,#recordBtn,#clearFilesBtn','files.write'],
    ['#newSessionBtn,#attachBtn,#createSessionBtn','sessions.write'],
    ['#retryBtn','prompt.send'],
    ['#syncBtn,#handbackBtn','sessions.write'],
    ['#abortBtn','prompt.abort'],
    ['#clearChatBtn','sessions.write'],
    ['#saveSettingsBtn','settings.write'],
    ['#restartBtn','system.restart'],
    ['#updateBtn','updates.run'],
    ['#clearLogsBtn','logs.clear'],
    ['#createUserBtn,#createGroupBtn,#createChatBtn,#createDiscordChannelBtn','users.write'],
    ['#lockSessionBtn,#unlockSessionBtn','sessions.write'],
    ['[data-switch]','sessions.write'],
    ['[data-queue],[data-q]','queue.write'],
    ['[data-del-art],#deleteSelectedArtifactsBtn','files.write'],
    ['[data-auth-login],[data-auth-logout]','auth.manage'],
    ['[data-update-agent],[data-update-send],[data-update-cancel],[data-update-delete-log]','updates.run'],
    ['[data-user-edit],[data-user-toggle],[data-user-code],[data-user-link],[data-user-discord-code],[data-user-discord-link],[data-user-password],[data-user-revoke],[data-telegram-unlink],[data-discord-unlink],[data-group-edit],[data-chat-edit],[data-chat-toggle],[data-discord-channel-edit],[data-discord-channel-toggle]','users.write'],
  ];
  disableMap.forEach(([selector,permission])=>document.querySelectorAll(selector).forEach(el=>{el.disabled=!can(permission);if(!can(permission))el.title='Permission required: '+permission}));
}
function modelLabel(m){const meta=[m.contextWindow?compactNum(m.contextWindow):'',m.supportsImages===true?'img':m.supportsImages===false?'text':'',m.supportsThinking===true?'think':''].filter(Boolean).join(' ');return (m.displayName||m.slug)+(meta?' · '+meta:'')}
function fmtAge(ms){const sec=Math.max(0,Math.floor(ms/1000));if(sec<60)return sec+'s ago';const min=Math.floor(sec/60);if(min<60)return min+'m ago';return Math.floor(min/60)+'h ago'}
function isCliRunningStatus(msg){return / CLI running\\b/.test(String(msg||''))}
function isCliDoneStatus(msg){return / CLI task\\b/.test(String(msg||''))}
function applyTheme(theme){document.documentElement.dataset.theme=theme;localStorage.setItem('nordrelayTheme',theme);document.getElementById('themeBtn').textContent=theme==='dark'?'Light':'Dark'}
function toggleTheme(){applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark')}
function page(name){state.currentPage=name;document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.page===name));document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id==='page-'+name));document.getElementById('pageTitle').textContent=name[0].toUpperCase()+name.slice(1);document.getElementById('sidebar').classList.remove('open'); void reloadCurrentPage().catch(err=>toast(err.message||String(err)));}
async function reloadCurrentPage(options={}){const name=state.currentPage;if(name==='overview') await loadActiveSessions(); if(name==='chat'){await loadChatHistory();scrollChatToBottom()} if(name==='sessions') await loadSessions(true,options.agentId); if(name==='settings') await loadSettings(); if(name==='logs') await loadLogs(); if(name==='diagnostics') await loadDiagnostics(); if(name==='artifacts') await loadArtifacts(); if(name==='activity') await loadActivity(); if(name==='tasks') await loadTasks(); if(name==='metrics') await loadMetrics(); if(name==='adapters') await loadAdapterHealth(); if(name==='access') await loadAccess(); if(name==='version') await loadVersion();}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>page(b.dataset.page));
document.getElementById('menuBtn').onclick=()=>document.getElementById('sidebar').classList.toggle('open');
document.getElementById('refreshBtn').onclick=()=>loadBootstrap();
document.getElementById('themeBtn').onclick=toggleTheme;
document.getElementById('logoutBtn').onclick=()=>safe(async()=>{await api('/api/dashboard/logout',{method:'POST'});location.href='/'});
applyTheme(localStorage.getItem('nordrelayTheme') || 'light');
