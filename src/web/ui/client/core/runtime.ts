const PLUGIN_PANEL_PAGE_STORAGE_KEY='nordrelayPluginPanelPage';
function readStoredPluginPanelPage(){
  try{
    const parsed=JSON.parse(localStorage.getItem(PLUGIN_PANEL_PAGE_STORAGE_KEY)||'null');
    return parsed&&typeof parsed==='object'&&parsed.pluginId&&parsed.panelId?parsed:null;
  }catch{return null}
}
function writeStoredPluginPanelPage(value){
  if(value)localStorage.setItem(PLUGIN_PANEL_PAGE_STORAGE_KEY,JSON.stringify(value));
  else localStorage.removeItem(PLUGIN_PANEL_PAGE_STORAGE_KEY);
}
const state: DashboardState = { snapshot:null, snapshotPeerId:'local', controls:null, newSessionControls:null, enabledAgents:[], auth:null, profile:null, csrfToken:null, apiStatus:{local:defaultApiStateEntry('local'),peers:{}}, authReloading:false, bootstrapReady:false, pendingPageReload:null, permissions:[], settings:[], settingsDraft:{}, settingsErrors:{}, settingsSearch:'', settingsOpenCategories:{}, currentPage:'overview', settingsGroup:null, settingsWizard:null, accessTab:'users', adapterTab:'adapters', pluginTab:'installed', pluginPanelPage:readStoredPluginPanelPage(), pluginPanelNavLoadedAt:0, pluginPanelNavPeer:'', pluginMarketplace:null, peerTab:'status', workflowTab:'templates', queueTab:'queue', sessionTab:'sessions', monitorTab:'activity', diagnosticsTab:'overview', queuePlanner:null, workflowTemplates:[], workflows:[], workflowRuns:[], logsPlain:'', logTimer:null, toastTimer:null, stickyToastActive:false, stickyToastText:'', cliStatusActive:false, webMirror:null, selectedArtifactTurns:new Set(), mediaRecorder:null, recordedChunks:[], events:null, eventsTarget:'', eventsContextKey:'', eventsLastEventIds:{}, eventsSeenIds:{}, reconnectTimer:null, notifications:false, completionSound:false, completionSoundAudioContext:null, completionSoundArmedKey:null, toolTooltipTimer:null, toolTooltipTarget:null, toolsVisible:false, chatSidebarMode:null, themePreference:null, agentUpdateJobs:[], versionRequestId:0, sessionsRequestId:0, sessionAgeTimer:null, activityAgeTimer:null, chatWorkingTimer:null, chatHistoryFollowupTimer:null, queueRealtimeRefreshTimer:null, chatVisibleCompletion:null, sessionDetailRefreshTimer:null, sessionDetailAgeTimer:null, sessionDetailThreadId:null, sessionDetailAgentId:null, sessionDetailPeerId:null, sessionDetailRequestId:0, chatActivationRequestId:0, chatHistoryRequestId:0, chatRenderVersion:0, chatHistoryPagination:null, chatHistoryLoadingOlder:false, chatOptimisticMessages:[], chatTabs:[], activeChatTabId:localStorage.getItem('nordrelayActiveChatTabId')||'', activeSessions:null, activeSessionsTimer:null, activeSessionDurationTimer:null, activeSessionsLoading:false, activeSessionsLastLoadAt:0, activeSessionsPeerBackoff:{}, activeSessionsTarget:localStorage.getItem('nordrelayActiveSessionsTarget')||'local', localTurnThreadId:null, localTurnAgentId:null, localTurnPeerId:null, localTurnStartedAt:null, peers:null, peerRelay:null, peerRefreshTimer:null, peerInviteSecrets:{}, peerProbeResult:null, peerDiscoveryJobs:[], incrementalRenders:{}, selectedPeer:localStorage.getItem('nordrelayPeerTarget')||'local' };
globalThis.NORDRELAY_WEBUI_RUNTIME_STATE=state;
const PAGE_LABELS={overview:'Overview',chat:'Chat',workflows:'Workflows',sessions:'Sessions',queue:'Queue',monitor:'Monitor',tasks:'Monitor',metrics:'Metrics',activity:'Monitor',trace:'Monitor',artifacts:'Monitor',adapters:'Adapters',peers:'Peers',plugins:'Plugins','plugin-panel':'Plugin Panel',access:'Users',version:'Version',settings:'Settings',logs:'Logs',diagnostics:'Diagnostics'};
const PAGE_STORAGE_KEY='nordrelayLastPage';
const MONITOR_PAGE_ALIASES=new Set(['activity','tasks','trace','artifacts']);
const LOCAL_ONLY_PAGES=new Set(['access','settings','peers','workflows']);
const NAV_OPEN_STORAGE_KEY='nordrelayNavOpenSections';
function toast(msg,options:WebuiToastOptions={}){const el=document.getElementById('toast');const text=String(msg??'');if(state.toastTimer)clearTimeout(state.toastTimer);state.toastTimer=null;if(options.sticky){state.stickyToastActive=true;state.stickyToastText=text;if(el.textContent!==text)el.textContent=text;if(el.style.display!=='block')el.style.display='block';return}el.textContent=text;el.style.display='block';state.toastTimer=setTimeout(()=>{state.toastTimer=null;if(state.stickyToastActive){el.textContent=state.stickyToastText;el.style.display='block';return}el.style.display='none'},options.duration||3500)}
function clearStickyToast(){state.stickyToastActive=false;state.stickyToastText='';if(state.toastTimer)clearTimeout(state.toastTimer);state.toastTimer=null}
function esc(s){return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function attr(s){return esc(s).replace(/"/g,'&quot;')}
function cssEscape(s){return window.CSS&&CSS.escape?CSS.escape(s):String(s).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&')}
function short(s,max=250){const text=String(s??'');return text.length>max?text.slice(0,max-1)+'...':text}
function createWebCorrelationId(){return (crypto.randomUUID?crypto.randomUUID().replace(/-/g,''):String(Date.now())+Math.random().toString(16).slice(2)).slice(0,12)}
async function copyText(text,label='Copied'){if(!text)return;try{await navigator.clipboard.writeText(text)}catch{const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();document.execCommand('copy');area.remove()}toast(label)}
function fmtDate(s){return s?new Date(s).toLocaleString(): '-'}
function fmtSessionAge(s){if(!s)return'-';const time=new Date(s).getTime();if(!Number.isFinite(time))return'-';const sec=Math.max(0,Math.floor((Date.now()-time)/1000));if(sec<60)return sec+'s';const min=Math.floor(sec/60);if(min<60)return min+'m '+(sec%60)+'s';const hours=Math.floor(min/60);if(hours<24)return hours+'h '+(min%60)+'m';const days=Math.floor(hours/24);return days+'d '+(hours%24)+'h'}
function fmtRelativeAgo(s){const age=fmtSessionAge(s);return age==='-'?'-':age+' ago'}
function updateSessionAgeCounters(){document.querySelectorAll('[data-session-age-at]').forEach(el=>{el.textContent=fmtSessionAge(el.dataset.sessionAgeAt)})}
function hasSessionAgeCounters(){return Boolean(document.querySelector('[data-session-age-at]'))}
function stopSessionAgeCounter(){if(state.sessionAgeTimer)clearInterval(state.sessionAgeTimer);state.sessionAgeTimer=null}
function startSessionAgeCounter(){updateSessionAgeCounters();if(state.sessionAgeTimer)return;state.sessionAgeTimer=setInterval(()=>{if(!hasSessionAgeCounters()){stopSessionAgeCounter();return}updateSessionAgeCounters()},1000)}
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
    ['#sendPromptBtn,#promptInput','prompt.send'],
    ['#templatePickerBtn','workflows.read'],
    ['#fileInput,#recordBtn,#clearFilesBtn','files.write'],
    ['#newSessionBtn,#attachBtn,#createSessionBtn','sessions.write'],
    ['.message-retry-button','prompt.send'],
    ['#syncBtn','sessions.write'],
    ['#controlModel,#controlReasoning,#controlFast,#controlLaunch','settings.write'],
    ['#abortBtn','prompt.abort'],
    ['#clearChatBtn','sessions.write'],
    ['#saveSettingsBtn','settings.write'],
    ['#settingsWizardBtn','settings.write'],
    ['#restartBtn','system.restart'],
    ['#updateBtn','updates.run'],
    ['#clearLogsBtn','logs.clear'],
    ['#createTemplateBtn,#createWorkflowBtn','workflows.write'],
    ['#createUserBtn,#createGroupBtn,#createChatBtn,#createDiscordChannelBtn,#createSlackChannelBtn,#createMatrixRoomBtn','users.write'],
    ['#createPeerInviteBtn,#addPeerBtn,[data-peer-edit],[data-peer-toggle],[data-peer-delete],[data-peer-invite-delete]','peers.write'],
    ['#openInstallPluginDialogBtn,#installPluginBtn,#validatePluginSourceBtn,#createPluginScaffoldBtn,[data-plugin-remove],[data-plugin-reload]','plugins.install'],
    ['[data-plugin-enable],[data-plugin-disable]','plugins.enable'],
    ['[data-plugin-settings]','plugins.settings.write'],
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
    ['[data-user-edit],[data-user-toggle],[data-user-code],[data-user-link],[data-user-discord-code],[data-user-discord-link],[data-user-slack-code],[data-user-slack-link],[data-user-matrix-code],[data-user-matrix-link],[data-user-password],[data-user-revoke],[data-telegram-unlink],[data-discord-unlink],[data-slack-unlink],[data-matrix-unlink],[data-group-edit],[data-chat-edit],[data-chat-toggle],[data-discord-channel-edit],[data-discord-channel-toggle],[data-slack-channel-edit],[data-slack-channel-toggle],[data-matrix-room-edit],[data-matrix-room-toggle]','users.write'],
  ];
  disableMap.forEach(([selector,permission])=>document.querySelectorAll(selector).forEach(el=>{
    const allowed=can(permission);
    const stateDisabled=el.dataset.stateDisabled==='true';
    el.disabled=!allowed||stateDisabled;
    if(!allowed)el.title='Permission required: '+permission;
    else if(stateDisabled&&el.dataset.stateDisabledTitle)el.title=el.dataset.stateDisabledTitle;
  }));
}
function readOpenNavSections(){try{const raw=localStorage.getItem(NAV_OPEN_STORAGE_KEY);if(!raw)return null;const parsed=JSON.parse(raw);return Array.isArray(parsed)?new Set(parsed.filter(Boolean)):null}catch{return null}}
function writeOpenNavSections(){const open=[...document.querySelectorAll('[data-nav-section]')].filter(section=>section.dataset.navOpen==='true').map(section=>section.dataset.navSection).filter(Boolean);localStorage.setItem(NAV_OPEN_STORAGE_KEY,JSON.stringify(open))}
function setNavSectionOpen(sectionId,open,options:WebuiPersistOptions={}){const section=document.querySelector('[data-nav-section="'+cssEscape(sectionId)+'"]');if(!section)return;const items=section.querySelector('.nav-section-items');const toggle=section.querySelector('[data-nav-toggle]');section.dataset.navOpen=open?'true':'false';if(items)items.hidden=!open;if(toggle)toggle.setAttribute('aria-expanded',open?'true':'false');if(options.persist!==false)writeOpenNavSections()}
function sectionForPage(name){if(name==='plugin-panel')return'plugins';const button=document.querySelector('nav button[data-page="'+cssEscape(name)+'"]');return button?.closest('[data-nav-section]')?.dataset.navSection||''}
function openSectionForPage(name,options:WebuiPersistOptions={}){const sectionId=sectionForPage(name);if(sectionId)setNavSectionOpen(sectionId,true,options)}
function syncNavSections(){
  document.querySelectorAll('[data-nav-section]').forEach(section=>{
    const visiblePages=[...section.querySelectorAll('button[data-page]')].filter(button=>!button.hidden);
    const hasVisiblePages=visiblePages.length>0;
    section.hidden=!hasVisiblePages;
    const active=visiblePages.some(button=>button.dataset.page===state.currentPage)||(state.currentPage==='plugin-panel'&&section.dataset.navSection==='plugins');
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
Object.assign(window,{clearStickyToast,isCliDoneStatus,toast});
function pageTitleLabel(name){if(name==='plugin-panel')return pluginPanelPageTitle();return PAGE_LABELS[name]||name[0].toUpperCase()+name.slice(1)}
function availableNodeCount(){const targets=(state.peerTargets||[]).filter(target=>target?.id);if(targets.length)return targets.length;const peers=(state.peers?.peers||[]).filter(peer=>peer?.enabled!==false&&peer?.id&&peer?.url);return 1+peers.length}
function pageUsesSelectedPeer(name=state.currentPage){return !LOCAL_ONLY_PAGES.has(name)}
function selectedNodeBadgeHtml(name=state.currentPage){if(!pageUsesSelectedPeer(name))return'';const peerId=state.selectedPeer||'local';if(peerId==='local'||availableNodeCount()<2)return'';const label=headerTargetName(peerId);return ' <span id="pageNodeBadge" class="page-node-badge" title="'+attr('Showing data from '+label)+'">'+esc(label)+'</span>'}
function renderPageTitle(name=state.currentPage){const el=document.getElementById('pageTitle');if(!el)return;const label=pageTitleLabel(name);el.innerHTML='<span class="page-title-text">'+esc(label)+'</span>'+selectedNodeBadgeHtml(name)}
function normalizeThemePreference(value){return value==='dark'||value==='light'||value==='system'?value:'light'}
function savedThemePreference(){return normalizeThemePreference(localStorage.getItem('nordrelayThemePreference')||localStorage.getItem('nordrelayTheme')||'light')}
function resolveThemePreference(preference){const pref=normalizeThemePreference(preference);if(pref==='system')return window.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light';return pref}
function applyThemePreference(preference,options:WebuiPersistOptions={}){const pref=normalizeThemePreference(preference);state.themePreference=pref;const resolved=resolveThemePreference(pref);document.documentElement.dataset.theme=resolved;if(options.persist!==false){localStorage.setItem('nordrelayThemePreference',pref);localStorage.setItem('nordrelayTheme',resolved)}updateThemeControls();syncPluginPanelThemes?.()}
function applyTheme(theme){applyThemePreference(theme)}
function toggleTheme(){applyThemePreference(document.documentElement.dataset.theme==='dark'?'light':'dark')}
function updateThemeControls(){const pref=state.themePreference||savedThemePreference();document.querySelectorAll('[data-theme-choice]').forEach(button=>{const active=button.dataset.themeChoice===pref;button.classList.toggle('active',active);button.setAttribute('aria-checked',active?'true':'false')});const select=document.getElementById('profileThemeSelect');if(select)select.value=pref}
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change',()=>{if((state.themePreference||savedThemePreference())==='system')applyThemePreference('system',{persist:false})});
function setChatSidePanelMode(mode){const next=mode==='tools'||mode==='history'?mode:null;state.toolsVisible=Boolean(next);state.chatSidebarMode=next;const layout=document.getElementById('chatLayout');const panel=document.getElementById('toolPanel');const title=document.getElementById('toolPanelTitle');const tools=document.getElementById('toolStream');const history=document.getElementById('promptHistoryStream');const toolsButton=document.getElementById('toggleToolsBtn');const historyButton=document.getElementById('toggleHistoryBtn');layout?.classList.toggle('tools-hidden',!state.toolsVisible);if(panel)panel.hidden=!state.toolsVisible;if(title)title.textContent=next==='history'?'History':'Tools / Plan';if(tools)tools.hidden=next!=='tools';if(history)history.hidden=next!=='history';if(toolsButton){toolsButton.textContent=next==='tools'?'Hide Tools':'Show Tools';toolsButton.setAttribute('aria-expanded',next==='tools'?'true':'false')}if(historyButton){historyButton.textContent=next==='history'?'Hide History':'Show History';historyButton.setAttribute('aria-expanded',next==='history'?'true':'false')}if(next==='history')renderPromptHistorySidebar()}
function setToolsVisible(visible){setChatSidePanelMode(visible?'tools':null)}
function toggleTools(){setChatSidePanelMode(state.chatSidebarMode==='tools'?null:'tools')}
function togglePromptHistory(){setChatSidePanelMode(state.chatSidebarMode==='history'?null:'history')}
function setChatMoreOpen(open){const menu=document.getElementById('chatMoreMenu');const button=document.getElementById('chatMoreBtn');if(menu)menu.hidden=!open;if(button)button.setAttribute('aria-expanded',open?'true':'false')}
function closeChatMoreMenu(){setChatMoreOpen(false)}
function isDialogBackdropClick(event){const dialog=event.target;if(!(dialog instanceof HTMLDialogElement)||!dialog.open)return false;const rect=dialog.getBoundingClientRect();return event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom}
function bindDialogBackdropClose(){document.addEventListener('click',event=>{if(isDialogBackdropClick(event)){event.preventDefault();event.target.close()}})}
function normalizePageName(name){if(MONITOR_PAGE_ALIASES.has(name)){state.monitorTab=name;return'monitor'}return name||'overview'}
function isMonitorTabActive(tab){return state.currentPage==='monitor'&&state.monitorTab===tab}
function syncPluginPanelNavActive(){
  const selected=state.pluginPanelPage;
  document.querySelectorAll('[data-plugin-panel-nav]').forEach(button=>{
    const active=state.currentPage==='plugin-panel'&&selected&&button.dataset.pluginId===selected.pluginId&&button.dataset.panelId===selected.panelId;
    button.classList.toggle('active',Boolean(active));
  });
}
function setMobileMenuOpen(open){const sidebar=document.getElementById('sidebar');const button=document.getElementById('menuBtn');sidebar?.classList.toggle('open',Boolean(open));if(button)button.setAttribute('aria-expanded',open?'true':'false')}
function toggleMobileMenu(){setMobileMenuOpen(!document.getElementById('sidebar')?.classList.contains('open'))}
function cleanupPluginPanelsForPageLeave(nextPage){if(state.currentPage===nextPage)return;const current=document.getElementById('page-'+state.currentPage);if(current)cleanupPluginPanelSurfaces(current)}
function page(name,options:WebuiPersistOptions={}){if(state.currentPage==='chat')saveActiveChatTabDraft();name=normalizePageName(name);cleanupPluginPanelsForPageLeave(name);state.currentPage=name;if(options.persist!==false){localStorage.setItem(PAGE_STORAGE_KEY,name);if(location.hash.slice(1)!==name)history.replaceState(null,'','#'+name)}if(name!=='sessions')stopSessionAgeCounter();if(name!=='peers')stopPeerTableRefresh();syncActiveSessionsRefresh();openSectionForPage(name);document.querySelectorAll('nav button[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===name));syncPluginPanelNavActive();syncNavSections();document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id==='page-'+name));renderPageTitle(name);setMobileMenuOpen(false);if(!state.bootstrapReady){state.pendingPageReload=name;return} void reloadCurrentPage().catch(handleUiError);}
async function reloadCurrentPage(options:WebuiReloadPageOptions={}){const name=state.currentPage;if(name==='overview') await loadActiveSessions(); if(name==='chat'){await ensureActiveChatTabSelected();const [historyRendered]=await Promise.all([loadChatHistory({forceScroll:true}),loadActiveSessions()]);renderChatTabs();const input=document.getElementById('promptInput');if(input&&!input.value)restoreActiveChatTabDraft();if(historyRendered)scrollChatToBottom({force:true})} if(name==='workflows') await loadWorkflows(); if(name==='sessions'){await loadSessions(true,options.agentId);if(state.sessionTab==='worktrees')await loadWorktrees()} if(name==='queue') await loadQueue(); if(name==='monitor') await loadMonitor(); if(name==='settings') await loadSettings(); if(name==='logs') await loadLogs(); if(name==='diagnostics') await loadDiagnostics(); if(name==='metrics') await loadMetrics(); if(name==='adapters') await loadAdapterHealth(); if(name==='peers') await loadPeers(); if(name==='plugins') await loadPlugins(); if(name==='plugin-panel') await loadPluginPanelPage(); if(name==='access') await loadAccess(); if(name==='version') await loadVersion();}
async function finishBootstrapNavigation(){state.bootstrapReady=true;const pending=state.pendingPageReload;state.pendingPageReload=null;if(pending&&pending!==state.currentPage){page(pending,{persist:false});return}if(pending||state.currentPage!=='overview')await reloadCurrentPage();}
document.querySelectorAll('nav button[data-page]').forEach(b=>b.onclick=()=>page(b.dataset.page));
document.querySelectorAll('[data-nav-toggle]').forEach(b=>b.onclick=()=>{const sectionId=b.dataset.navToggle;const section=document.querySelector('[data-nav-section="'+cssEscape(sectionId)+'"]');setNavSectionOpen(sectionId,section?.dataset.navOpen!=='true');syncNavSections()});
initNavSections();
document.getElementById('brandHomeBtn').onclick=()=>page('overview');
document.getElementById('menuBtn').onclick=event=>{event.stopPropagation();toggleMobileMenu()};
document.addEventListener('click',event=>{const sidebar=document.getElementById('sidebar');if(!sidebar?.classList.contains('open'))return;if(sidebar.contains(event.target as Node))return;setMobileMenuOpen(false)});
document.addEventListener('click',event=>{if(event.target.closest?.('.chat-more-menu'))return;closeChatMoreMenu()});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){setMobileMenuOpen(false);closeChatMoreMenu()}});
document.getElementById('chatMoreBtn').onclick=event=>{event.preventDefault();event.stopPropagation();const menu=document.getElementById('chatMoreMenu');setChatMoreOpen(Boolean(menu?.hidden))};
document.getElementById('chatMoreMenu')?.addEventListener('click',event=>{if(event.target.closest?.('button'))closeChatMoreMenu()});
document.getElementById('toggleToolsBtn').onclick=toggleTools;
document.getElementById('toggleHistoryBtn').onclick=togglePromptHistory;
document.getElementById('logoutBtn').onclick=()=>safe(async()=>{await api('/api/dashboard/logout',{method:'POST'});location.href='/'});
bindDialogBackdropClose();
applyThemePreference(savedThemePreference(),{persist:false});
setToolsVisible(false);
function registerPwa(){if('serviceWorker' in navigator)navigator.serviceWorker.register('/service-worker.js').catch(()=>{});window.addEventListener('hashchange',()=>{const name=location.hash.slice(1);if(name&&name!==state.currentPage)page(name,{persist:false})});const initial=location.hash.slice(1)||localStorage.getItem(PAGE_STORAGE_KEY);if(initial&&initial!==state.currentPage)setTimeout(()=>page(initial,{persist:false}),0)}
registerPwa();
