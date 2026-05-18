const state = { snapshot:null, controls:null, newSessionControls:null, enabledAgents:[], auth:null, profile:null, csrfToken:null, permissions:[], settings:[], currentPage:'overview', settingsGroup:null, settingsWizard:null, accessTab:'users', adapterTab:'adapters', peerTab:'status', workflowTab:'templates', queueTab:'queue', monitorTab:'activity', queuePlanner:null, workflowTemplates:[], workflows:[], workflowRuns:[], logsPlain:'', logTimer:null, toastTimer:null, stickyToastActive:false, stickyToastText:'', cliStatusActive:false, webMirror:null, selectedArtifactTurns:new Set(), mediaRecorder:null, recordedChunks:[], events:null, reconnectTimer:null, notifications:false, toolTooltipTimer:null, toolTooltipTarget:null, toolsVisible:false, themePreference:null, agentUpdateJobs:[], versionRequestId:0, sessionsRequestId:0, sessionAgeTimer:null, activityAgeTimer:null, chatHistoryRequestId:0, chatRenderVersion:0, activeSessions:null, peers:null, peerRelay:null, peerInviteSecrets:{}, peerProbeResult:null, peerDiscoveryJobs:[], selectedPeer:localStorage.getItem('nordrelayPeerTarget')||'local' };
globalThis.NORDRELAY_WEBUI_RUNTIME_STATE=state;
const PAGE_LABELS={overview:'Overview',chat:'Chat',workflows:'Workflows',sessions:'Sessions',queue:'Queue',monitor:'Monitor',tasks:'Monitor',metrics:'Metrics',activity:'Monitor',trace:'Monitor',artifacts:'Monitor',adapters:'Adapters',peers:'Peers',access:'Users',version:'Version',settings:'Settings',logs:'Logs',diagnostics:'Diagnostics'};
const PAGE_STORAGE_KEY='nordrelayLastPage';
const MONITOR_PAGE_ALIASES=new Set(['activity','tasks','trace','artifacts']);
const NAV_OPEN_STORAGE_KEY='nordrelayNavOpenSections';
function toast(msg,options={}){const el=document.getElementById('toast');const text=String(msg??'');if(state.toastTimer)clearTimeout(state.toastTimer);state.toastTimer=null;if(options.sticky){state.stickyToastActive=true;state.stickyToastText=text;if(el.textContent!==text)el.textContent=text;if(el.style.display!=='block')el.style.display='block';return}el.textContent=text;el.style.display='block';state.toastTimer=setTimeout(()=>{state.toastTimer=null;if(state.stickyToastActive){el.textContent=state.stickyToastText;el.style.display='block';return}el.style.display='none'},options.duration||3500)}
function clearStickyToast(){state.stickyToastActive=false;state.stickyToastText='';if(state.toastTimer)clearTimeout(state.toastTimer);state.toastTimer=null}
function esc(s){return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function attr(s){return esc(s).replace(/"/g,'&quot;')}
function cssEscape(s){return window.CSS&&CSS.escape?CSS.escape(s):String(s).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&')}
function short(s,max=250){const text=String(s??'');return text.length>max?text.slice(0,max-1)+'...':text}
async function copyText(text,label='Copied'){if(!text)return;try{await navigator.clipboard.writeText(text)}catch{const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();document.execCommand('copy');area.remove()}toast(label)}
function fmtDate(s){return s?new Date(s).toLocaleString(): '-'}
function fmtSessionAge(s){if(!s)return'-';const time=new Date(s).getTime();if(!Number.isFinite(time))return'-';const sec=Math.max(0,Math.floor((Date.now()-time)/1000));if(sec<60)return sec+'s';const min=Math.floor(sec/60);if(min<60)return min+'m '+(sec%60)+'s';const hours=Math.floor(min/60);if(hours<24)return hours+'h '+(min%60)+'m';const days=Math.floor(hours/24);return days+'d '+(hours%24)+'h'}
function fmtRelativeAgo(s){const age=fmtSessionAge(s);return age==='-'?'-':age+' ago'}
function updateSessionAgeCounters(){document.querySelectorAll('[data-session-age-at]').forEach(el=>{el.textContent=fmtSessionAge(el.dataset.sessionAgeAt)})}
function stopSessionAgeCounter(){if(state.sessionAgeTimer)clearInterval(state.sessionAgeTimer);state.sessionAgeTimer=null}
function startSessionAgeCounter(){updateSessionAgeCounters();if(state.sessionAgeTimer)return;state.sessionAgeTimer=setInterval(()=>{if(state.currentPage!=='sessions'){stopSessionAgeCounter();return}updateSessionAgeCounters()},1000)}
function updateActivityAgeCounters(){document.querySelectorAll('[data-activity-age-at]').forEach(el=>{el.textContent=fmtRelativeAgo(el.dataset.activityAgeAt)})}
function stopActivityAgeCounter(){if(state.activityAgeTimer)clearInterval(state.activityAgeTimer);state.activityAgeTimer=null}
function monitorTabHasAgeCounters(){return state.currentPage==='monitor'&&(state.monitorTab==='activity'||state.monitorTab==='tasks'||state.monitorTab==='trace')}
function startActivityAgeCounter(){updateActivityAgeCounters();if(state.activityAgeTimer)return;state.activityAgeTimer=setInterval(()=>{if(!monitorTabHasAgeCounters()){stopActivityAgeCounter();return}updateActivityAgeCounters()},1000)}
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
  syncNavSections();
  const currentButton=document.querySelector('nav button[data-page="'+cssEscape(state.currentPage)+'"]');
  if(currentButton&&currentButton.hidden){const first=[...document.querySelectorAll('nav button[data-page]')].find(b=>!b.hidden);if(first)page(first.dataset.page)}
  const disableMap=[
    ['#promptForm > button,#promptInput','prompt.send'],
    ['#templatePickerBtn','workflows.read'],
    ['#fileInput,#recordBtn,#clearFilesBtn','files.write'],
    ['#newSessionBtn,#attachBtn,#createSessionBtn','sessions.write'],
    ['#retryBtn','prompt.send'],
    ['#syncBtn,#handbackBtn','sessions.write'],
    ['#mirrorModeSelect','settings.write'],
    ['#controlModel,#controlReasoning,#controlLaunch,#applyLaunchBtn','settings.write'],
    ['#abortBtn','prompt.abort'],
    ['#clearChatBtn','sessions.write'],
    ['#saveSettingsBtn','settings.write'],
    ['#settingsWizardBtn','settings.write'],
    ['#restartBtn','system.restart'],
    ['#updateBtn','updates.run'],
    ['#clearLogsBtn','logs.clear'],
    ['#createTemplateBtn,#createWorkflowBtn','workflows.write'],
    ['#createUserBtn,#createGroupBtn,#createChatBtn,#createDiscordChannelBtn,#createSlackChannelBtn','users.write'],
    ['#createPeerInviteBtn,#addPeerBtn,[data-peer-edit],[data-peer-toggle],[data-peer-revoke],[data-peer-invite-delete]','peers.write'],
    ['#checkPeerReachabilityBtn,#discoverPeersBtn,#cancelPeerDiscoveryBtn,[data-peer-probe]','peers.connect'],
    ['#exportPeerIdentityBtn,#restorePeerIdentityBtn,#retryPeerRelayBtn,#drainPeerRelayBtn,[data-peer-repin],[data-peer-rotate],[data-peer-relay-cancel]','peers.write'],
    ['#lockSessionBtn,#unlockSessionBtn','sessions.write'],
    ['[data-switch]','sessions.write'],
    ['[data-queue],[data-q]','queue.write'],
    ['#reloadQueuePlansBtn,#reloadQueueProgressBtn','queue.plan.read'],
    ['#createQueuePlanBtn,[data-plan-edit],[data-plan-delete],[data-plan-move]','queue.plan.write'],
    ['[data-plan-approve],[data-plan-enqueue]','queue.plan.approve'],
    ['[data-del-art],#deleteSelectedArtifactsBtn','files.write'],
    ['[data-auth-login],[data-auth-logout]','auth.manage'],
    ['[data-update-agent],[data-update-send],[data-update-cancel],[data-update-delete-log]','updates.run'],
    ['[data-user-edit],[data-user-toggle],[data-user-code],[data-user-link],[data-user-discord-code],[data-user-discord-link],[data-user-slack-code],[data-user-slack-link],[data-user-password],[data-user-revoke],[data-telegram-unlink],[data-discord-unlink],[data-slack-unlink],[data-group-edit],[data-chat-edit],[data-chat-toggle],[data-discord-channel-edit],[data-discord-channel-toggle],[data-slack-channel-edit],[data-slack-channel-toggle]','users.write'],
  ];
  disableMap.forEach(([selector,permission])=>document.querySelectorAll(selector).forEach(el=>{el.disabled=!can(permission);if(!can(permission))el.title='Permission required: '+permission}));
}
function readOpenNavSections(){try{const raw=localStorage.getItem(NAV_OPEN_STORAGE_KEY);if(!raw)return null;const parsed=JSON.parse(raw);return Array.isArray(parsed)?new Set(parsed.filter(Boolean)):null}catch{return null}}
function writeOpenNavSections(){const open=[...document.querySelectorAll('[data-nav-section]')].filter(section=>section.dataset.navOpen==='true').map(section=>section.dataset.navSection).filter(Boolean);localStorage.setItem(NAV_OPEN_STORAGE_KEY,JSON.stringify(open))}
function setNavSectionOpen(sectionId,open,options={}){const section=document.querySelector('[data-nav-section="'+cssEscape(sectionId)+'"]');if(!section)return;const items=section.querySelector('.nav-section-items');const toggle=section.querySelector('[data-nav-toggle]');section.dataset.navOpen=open?'true':'false';if(items)items.hidden=!open;if(toggle)toggle.setAttribute('aria-expanded',open?'true':'false');if(options.persist!==false)writeOpenNavSections()}
function sectionForPage(name){const button=document.querySelector('nav button[data-page="'+cssEscape(name)+'"]');return button?.closest('[data-nav-section]')?.dataset.navSection||''}
function openSectionForPage(name,options={}){const sectionId=sectionForPage(name);if(sectionId)setNavSectionOpen(sectionId,true,options)}
function syncNavSections(){
  document.querySelectorAll('[data-nav-section]').forEach(section=>{
    const visiblePages=[...section.querySelectorAll('button[data-page]')].filter(button=>!button.hidden);
    const hasVisiblePages=visiblePages.length>0;
    section.hidden=!hasVisiblePages;
    const active=visiblePages.some(button=>button.dataset.page===state.currentPage);
    section.classList.toggle('active',active);
    section.querySelector('[data-nav-toggle]')?.classList.toggle('active',active);
    if(active&&section.dataset.navOpen!=='true')setNavSectionOpen(section.dataset.navSection,true,{persist:false});
  });
}
function initNavSections(){
  const saved=readOpenNavSections();
  document.querySelectorAll('[data-nav-section]').forEach(section=>{
    const sectionId=section.dataset.navSection;
    const open=saved?saved.has(sectionId):section.dataset.navDefaultOpen==='true';
    setNavSectionOpen(sectionId,open,{persist:false});
  });
  openSectionForPage(state.currentPage,{persist:false});
  syncNavSections();
}
function modelLabel(m){const meta=[m.contextWindow?compactNum(m.contextWindow):'',m.supportsImages===true?'img':m.supportsImages===false?'text':'',m.supportsThinking===true?'think':''].filter(Boolean).join(' ');return (m.displayName||m.slug)+(meta?' · '+meta:'')}
function fmtAge(ms){const sec=Math.max(0,Math.floor(ms/1000));if(sec<60)return sec+'s ago';const min=Math.floor(sec/60);if(min<60)return min+'m ago';return Math.floor(min/60)+'h ago'}
function isCliRunningStatus(msg){return / CLI running\b/.test(String(msg||''))}
function isCliDoneStatus(msg){return / CLI task (?:finished|completed|failed|aborted)\b/i.test(String(msg||''))}
function normalizeThemePreference(value){return value==='dark'||value==='light'||value==='system'?value:'light'}
function savedThemePreference(){return normalizeThemePreference(localStorage.getItem('nordrelayThemePreference')||localStorage.getItem('nordrelayTheme')||'light')}
function resolveThemePreference(preference){const pref=normalizeThemePreference(preference);if(pref==='system')return window.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light';return pref}
function applyThemePreference(preference,options={}){const pref=normalizeThemePreference(preference);state.themePreference=pref;const resolved=resolveThemePreference(pref);document.documentElement.dataset.theme=resolved;if(options.persist!==false){localStorage.setItem('nordrelayThemePreference',pref);localStorage.setItem('nordrelayTheme',resolved)}updateThemeControls()}
function applyTheme(theme){applyThemePreference(theme)}
function toggleTheme(){applyThemePreference(document.documentElement.dataset.theme==='dark'?'light':'dark')}
function updateThemeControls(){const pref=state.themePreference||savedThemePreference();document.querySelectorAll('[data-theme-choice]').forEach(button=>{const active=button.dataset.themeChoice===pref;button.classList.toggle('active',active);button.setAttribute('aria-checked',active?'true':'false')});const select=document.getElementById('profileThemeSelect');if(select)select.value=pref}
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change',()=>{if((state.themePreference||savedThemePreference())==='system')applyThemePreference('system',{persist:false})});
function setToolsVisible(visible){state.toolsVisible=Boolean(visible);const layout=document.getElementById('chatLayout');const panel=document.getElementById('toolPanel');const button=document.getElementById('toggleToolsBtn');layout?.classList.toggle('tools-hidden',!state.toolsVisible);if(panel)panel.hidden=!state.toolsVisible;if(button){button.textContent=state.toolsVisible?'Hide Tools':'Show Tools';button.setAttribute('aria-expanded',state.toolsVisible?'true':'false')}}
function toggleTools(){setToolsVisible(!state.toolsVisible)}
function isDialogBackdropClick(event){const dialog=event.target;if(!(dialog instanceof HTMLDialogElement)||!dialog.open)return false;const rect=dialog.getBoundingClientRect();return event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom}
function bindDialogBackdropClose(){document.addEventListener('click',event=>{if(isDialogBackdropClick(event)){event.preventDefault();event.target.close()}})}
function normalizePageName(name){if(MONITOR_PAGE_ALIASES.has(name)){state.monitorTab=name;return'monitor'}return name||'overview'}
function isMonitorTabActive(tab){return state.currentPage==='monitor'&&state.monitorTab===tab}
function setMobileMenuOpen(open){const sidebar=document.getElementById('sidebar');const button=document.getElementById('menuBtn');sidebar?.classList.toggle('open',Boolean(open));if(button)button.setAttribute('aria-expanded',open?'true':'false')}
function toggleMobileMenu(){setMobileMenuOpen(!document.getElementById('sidebar')?.classList.contains('open'))}
function page(name,options={}){name=normalizePageName(name);state.currentPage=name;if(options.persist!==false){localStorage.setItem(PAGE_STORAGE_KEY,name);if(location.hash.slice(1)!==name)history.replaceState(null,'','#'+name)}if(name!=='sessions')stopSessionAgeCounter();openSectionForPage(name);document.querySelectorAll('nav button[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===name));syncNavSections();document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id==='page-'+name));document.getElementById('pageTitle').textContent=PAGE_LABELS[name]||name[0].toUpperCase()+name.slice(1);setMobileMenuOpen(false); void reloadCurrentPage().catch(err=>toast(err.message||String(err)));}
async function reloadCurrentPage(options={}){const name=state.currentPage;if(name==='overview') await loadActiveSessions(); if(name==='chat'){const [historyRendered]=await Promise.all([loadChatHistory({forceScroll:true}),loadMirrorPreference(),loadActiveSessions()]);if(historyRendered)scrollChatToBottom({force:true})} if(name==='workflows') await loadWorkflows(); if(name==='sessions'){await loadSessions(true,options.agentId);if(state.sessionTab==='worktrees')await loadWorktrees()} if(name==='queue') await loadQueue(); if(name==='monitor') await loadMonitor(); if(name==='settings') await loadSettings(); if(name==='logs') await loadLogs(); if(name==='diagnostics') await loadDiagnostics(); if(name==='metrics') await loadMetrics(); if(name==='adapters') await loadAdapterHealth(); if(name==='peers') await loadPeers(); if(name==='access') await loadAccess(); if(name==='version') await loadVersion();}
document.querySelectorAll('nav button[data-page]').forEach(b=>b.onclick=()=>page(b.dataset.page));
document.querySelectorAll('[data-nav-toggle]').forEach(b=>b.onclick=()=>{const sectionId=b.dataset.navToggle;const section=document.querySelector('[data-nav-section="'+cssEscape(sectionId)+'"]');setNavSectionOpen(sectionId,section?.dataset.navOpen!=='true');syncNavSections()});
initNavSections();
document.getElementById('brandHomeBtn').onclick=()=>page('overview');
document.getElementById('menuBtn').onclick=event=>{event.stopPropagation();toggleMobileMenu()};
document.addEventListener('click',event=>{const sidebar=document.getElementById('sidebar');if(!sidebar?.classList.contains('open'))return;if(sidebar.contains(/** @type {Node} */ (event.target)))return;setMobileMenuOpen(false)});
document.addEventListener('keydown',event=>{if(event.key==='Escape')setMobileMenuOpen(false)});
document.getElementById('toggleToolsBtn').onclick=toggleTools;
document.getElementById('logoutBtn').onclick=()=>safe(async()=>{await api('/api/dashboard/logout',{method:'POST'});location.href='/'});
bindDialogBackdropClose();
applyThemePreference(savedThemePreference(),{persist:false});
setToolsVisible(false);
function registerPwa(){if('serviceWorker' in navigator)navigator.serviceWorker.register('/service-worker.js').catch(()=>{});window.addEventListener('hashchange',()=>{const name=location.hash.slice(1);if(name&&name!==state.currentPage)page(name,{persist:false})});const initial=location.hash.slice(1)||localStorage.getItem(PAGE_STORAGE_KEY);if(initial&&initial!==state.currentPage)setTimeout(()=>page(initial,{persist:false}),0)}
registerPwa();
