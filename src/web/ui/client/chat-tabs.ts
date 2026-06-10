const CHAT_TABS_STORAGE_KEY = 'nordrelayChatTabs';
const ACTIVE_CHAT_TAB_STORAGE_KEY = 'nordrelayActiveChatTabId';
const CHAT_TAB_DRAFT_STORAGE_PREFIX = 'nordrelayChatDraft:';
const MAX_CHAT_TABS = 16;

function chatTabId(peerId: string, agentId: string, threadId: string) {
  return [peerId || 'local', agentId || '', threadId || ''].join('::');
}

function chatTabPeerId(tab: Partial<WebuiChatTab> | null | undefined) {
  return String(tab?.peerId || 'local');
}

function chatTabContextKey(tab: Partial<WebuiChatTab> | null | undefined) {
  const threadId = String(tab?.threadId || '').trim();
  if (!threadId) return '';
  return webProxyContextKey('/api/sessions/switch', 'POST', { threadId }, {}, '', chatTabPeerId(tab));
}

function activeChatTabContextKey() {
  return chatTabContextKey(activeChatTab());
}

function activeChatTabApiOptions<P extends WebApiPath>(options: WebApiClientOptions<P> = {} as WebApiClientOptions<P>): WebApiClientOptions<P> {
  const contextKey = activeChatTabContextKey();
  return contextKey ? { ...options, contextKey } : options;
}

function nextChatActivationRequestId() {
  state.chatActivationRequestId = (state.chatActivationRequestId || 0) + 1;
  return state.chatActivationRequestId;
}

function chatActivationStillCurrent(requestId: number, tab: WebuiChatTab) {
  return state.chatActivationRequestId === requestId
    && state.activeChatTabId === tab.id
    && String(state.selectedPeer || 'local') === chatTabPeerId(tab);
}

function normalizeChatTab(raw: Partial<WebuiChatTab> | null | undefined): WebuiChatTab | null {
  const threadId = String(raw?.threadId || '').trim();
  if (!threadId) return null;
  const peerId = String(raw?.peerId || 'local').trim() || 'local';
  const agentId = String(raw?.agentId || '').trim();
  const now = new Date().toISOString();
  const id = raw?.id || chatTabId(peerId, agentId, threadId);
  return {
    id,
    peerId,
    peerName: raw?.peerName ? String(raw.peerName) : '',
    agentId,
    agentLabel: raw?.agentLabel ? String(raw.agentLabel) : '',
    threadId,
    sessionName: raw?.sessionName ? String(raw.sessionName) : '',
    title: raw?.title ? String(raw.title) : '',
    workspace: raw?.workspace ? String(raw.workspace) : '',
    model: raw?.model ? String(raw.model) : '',
    draft: raw?.draft ? String(raw.draft) : '',
    openedAt: raw?.openedAt ? String(raw.openedAt) : now,
    lastActiveAt: raw?.lastActiveAt ? String(raw.lastActiveAt) : now,
  };
}

function readChatTabs(): WebuiChatTab[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_TABS_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.map(normalizeChatTab).filter(Boolean) as WebuiChatTab[] : [];
  } catch {
    return [];
  }
}

function ensureChatTabs() {
  if (!Array.isArray(state.chatTabs) || !state.chatTabs.length) state.chatTabs = readChatTabs();
  if (!state.activeChatTabId) state.activeChatTabId = localStorage.getItem(ACTIVE_CHAT_TAB_STORAGE_KEY) || '';
  return state.chatTabs;
}

function writeChatTabs() {
  const tabs = ensureChatTabs()
    .slice()
    .sort((left, right) => Date.parse(right.lastActiveAt || '') - Date.parse(left.lastActiveAt || ''))
    .slice(0, MAX_CHAT_TABS);
  state.chatTabs = tabs;
  localStorage.setItem(CHAT_TABS_STORAGE_KEY, JSON.stringify(tabs));
  if (state.activeChatTabId) localStorage.setItem(ACTIVE_CHAT_TAB_STORAGE_KEY, state.activeChatTabId);
  else localStorage.removeItem(ACTIVE_CHAT_TAB_STORAGE_KEY);
}

function activeChatTab() {
  return ensureChatTabs().find(tab => tab.id === state.activeChatTabId) || null;
}

function chatTabDraftStorageKey(tab: WebuiChatTab | null | undefined) {
  return tab?.id ? CHAT_TAB_DRAFT_STORAGE_PREFIX + tab.id : '';
}

function readChatTabDraft(tab: WebuiChatTab | null | undefined) {
  if (tab?.draft) return tab.draft;
  const key = chatTabDraftStorageKey(tab);
  if (!key) return '';
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function writeChatTabDraft(tab: WebuiChatTab | null | undefined, draft: string) {
  const key = chatTabDraftStorageKey(tab);
  if (!key) return;
  try {
    if (draft) localStorage.setItem(key, draft);
    else localStorage.removeItem(key);
  } catch {}
}

function writableActiveChatTab() {
  let tab = activeChatTab();
  if (!tab && state.snapshot?.session?.threadId) {
    tab = syncCurrentSessionChatTab({ activate: true });
  }
  return tab;
}

function currentSnapshotPeerId() {
  return String(state.snapshotPeerId || 'local');
}

function selectedPeerId() {
  return String(state.selectedPeer || 'local');
}

function snapshotMatchesSelectedPeer() {
  return currentSnapshotPeerId() === selectedPeerId();
}

function chatTabFromSession(session: WebuiSessionSnapshot | null | undefined, peerId = currentSnapshotPeerId()): WebuiChatTab | null {
  const threadId = String(session?.threadId || '').trim();
  if (!threadId) return null;
  return normalizeChatTab({
    peerId,
    peerName: headerTargetName(peerId),
    agentId: String(session?.agentId || ''),
    agentLabel: String(session?.agentLabel || session?.agentId || ''),
    threadId,
    sessionName: String(session?.sessionName || ''),
    title: String(session?.sessionName || session?.title || session?.firstUserMessage || ''),
    workspace: String(session?.workspace || ''),
    model: String(session?.model || ''),
  });
}

function chatTabFromActiveSession(session: WebuiActiveSession): WebuiChatTab | null {
  const peerId = String(session?.peerId || 'local');
  return normalizeChatTab({
    peerId,
    peerName: String(session?.nodeName || headerTargetName(peerId)),
    agentId: String(session?.agentId || ''),
    agentLabel: String(session?.agentLabel || session?.agentId || ''),
    threadId: String(session?.threadId || ''),
    sessionName: String(session?.sessionName || ''),
    title: String(session?.sessionName || session?.prompt || session?.threadId || ''),
    workspace: String(session?.workspace || ''),
    model: String(session?.model || ''),
  });
}

function refreshChatTabFromSession(tab: WebuiChatTab, session: WebuiSessionSnapshot | null | undefined) {
  if (!session?.threadId) return tab;
  return upsertChatTab({
    id: tab.id,
    peerId: tab.peerId || 'local',
    peerName: tab.peerName || headerTargetName(tab.peerId || 'local'),
    agentId: String(session.agentId || tab.agentId || ''),
    agentLabel: String(session.agentLabel || session.agentId || tab.agentLabel || tab.agentId || ''),
    threadId: String(session.threadId || tab.threadId || ''),
    sessionName: String(session.sessionName || tab.sessionName || ''),
    title: String(session.sessionName || session.title || session.firstUserMessage || tab.title || tab.threadId || ''),
    workspace: String(session.workspace || session.cwd || tab.workspace || ''),
    model: String(session.model || tab.model || ''),
  }, { activate: true }) || tab;
}

function upsertChatTab(rawTab: Partial<WebuiChatTab>, options: { activate?: boolean } = {}) {
  const normalized = normalizeChatTab(rawTab);
  if (!normalized) return null;
  const tabs = ensureChatTabs();
  const existing = tabs.find(tab => tab.id === normalized.id);
  const input = document.getElementById('promptInput') as HTMLTextAreaElement | null;
  if (state.activeChatTabId && input) {
    const current = tabs.find(tab => tab.id === state.activeChatTabId);
    if (current) current.draft = input.value || '';
  }
  const next = {
    ...(existing || {}),
    ...normalized,
    peerName: normalized.peerName || existing?.peerName || '',
    agentLabel: normalized.agentLabel || existing?.agentLabel || normalized.agentId || '',
    sessionName: normalized.sessionName || existing?.sessionName || '',
    title: normalized.title || existing?.title || '',
    workspace: normalized.workspace || existing?.workspace || '',
    model: normalized.model || existing?.model || '',
    draft: normalized.draft || existing?.draft || '',
    lastActiveAt: options.activate ? new Date().toISOString() : (existing?.lastActiveAt || normalized.lastActiveAt),
  } as WebuiChatTab;
  if (existing) Object.assign(existing, next);
  else tabs.push(next);
  if (options.activate) state.activeChatTabId = next.id;
  writeChatTabs();
  return next;
}

function syncCurrentSessionChatTab(options: { activate?: boolean } = {}) {
  if (!snapshotMatchesSelectedPeer()) {
    renderChatTabs();
    return null;
  }
  const tab = chatTabFromSession(state.snapshot?.session || null, currentSnapshotPeerId());
  if (!tab) {
    renderChatTabs();
    return null;
  }
  const currentTabs = ensureChatTabs();
  const shouldActivate = options.activate === true || !state.activeChatTabId || !currentTabs.some(existing => existing.id === state.activeChatTabId);
  const saved = upsertChatTab(tab, { activate: shouldActivate });
  renderChatTabs();
  return saved;
}

function saveActiveChatTabDraft() {
  const input = document.getElementById('promptInput') as HTMLTextAreaElement | null;
  const tab = writableActiveChatTab();
  if (!tab || !input) return;
  const draft = input.value || '';
  writeChatTabDraft(tab, draft);
  if (tab.draft === draft) return;
  tab.draft = draft;
  writeChatTabs();
}

function restoreActiveChatTabDraft() {
  const tab = activeChatTab();
  const input = document.getElementById('promptInput') as HTMLTextAreaElement | null;
  if (!input) return;
  input.value = readChatTabDraft(tab);
}

function bindPromptDraftPersistence() {
  const input = document.getElementById('promptInput') as HTMLTextAreaElement | null;
  if (!input || input.dataset.draftPersistenceBound === 'true') return;
  input.dataset.draftPersistenceBound = 'true';
  input.addEventListener('input', saveActiveChatTabDraft);
  input.addEventListener('change', saveActiveChatTabDraft);
  window.addEventListener('pagehide', saveActiveChatTabDraft);
  window.addEventListener('beforeunload', saveActiveChatTabDraft);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveActiveChatTabDraft();
  });
}

function currentSnapshotMatchesChatTab(tab: WebuiChatTab) {
  const session = state.snapshot?.session || {};
  return String(session.threadId || '') === tab.threadId
    && String(session.agentId || '') === String(tab.agentId || '')
    && currentSnapshotPeerId() === String(tab.peerId || 'local');
}

function pruneMirroredLocalSnapshotChatTabs(local: WebuiBootstrap | null | undefined) {
  const session = local?.status?.snapshot?.session;
  const threadId = String(session?.threadId || '').trim();
  if (!threadId) return;
  const tabs = ensureChatTabs();
  const before = tabs.length;
  state.chatTabs = tabs.filter(tab => tab.peerId === 'local' || tab.threadId !== threadId);
  if (state.chatTabs.length === before) return;
  if (!state.chatTabs.some(tab => tab.id === state.activeChatTabId)) state.activeChatTabId = '';
  writeChatTabs();
  renderChatTabs();
}

async function activateChatTabSession(tab: WebuiChatTab, options: { navigate?: boolean; loadHistory?: boolean; reload?: boolean; toast?: boolean } = {}) {
  if (!tab?.threadId) return;
  saveActiveChatTabDraft();
  const requestId = nextChatActivationRequestId();
  const previousPeer = state.selectedPeer || 'local';
  const previousEventsContextKey = state.eventsContextKey || '';
  state.selectedPeer = chatTabPeerId(tab);
  localStorage.setItem('nordrelayPeerTarget', state.selectedPeer);
  state.activeChatTabId = tab.id;
  localStorage.setItem(ACTIVE_CHAT_TAB_STORAGE_KEY, tab.id);
  renderChatTabs();
  const contextKey = chatTabContextKey(tab);
  if (tab.agentId && state.snapshot?.session?.agentId !== tab.agentId) {
    await headerTargetRequest(state.selectedPeer, '/api/agent', { method: 'POST', body: JSON.stringify({ agentId: tab.agentId }), contextKey });
    if (!chatActivationStillCurrent(requestId, tab)) return;
  }
  const switched = await headerTargetRequest(state.selectedPeer, '/api/sessions/switch', { method: 'POST', body: JSON.stringify({ threadId: tab.threadId }), contextKey });
  if (!chatActivationStillCurrent(requestId, tab)) return;
  if (state.snapshot && switched.session) {
    state.snapshot.session = switched.session as WebuiSessionSnapshot;
    state.snapshotPeerId = state.selectedPeer || 'local';
    refreshChatTabFromSession(tab, switched.session as WebuiSessionSnapshot);
    renderSnapshot(state.snapshot);
  }
  await loadBootstrap({ contextKey });
  if (!chatActivationStillCurrent(requestId, tab)) return;
  if (previousPeer !== state.selectedPeer || (state.selectedPeer !== 'local' && previousEventsContextKey !== webProxyEventContextKey())) {
    connectEvents();
  }
  syncCurrentSessionChatTab({ activate: true });
  restoreActiveChatTabDraft();
  if (options.toast !== false) toast('Session switched');
  if (options.navigate && state.currentPage !== 'chat') {
    page('chat');
    return;
  }
  if (state.currentPage === 'chat' && options.loadHistory !== false) {
    const [historyRendered] = await Promise.all([
      loadChatHistory({ forceScroll: true, skipIfRendered: false }),
      loadActiveSessions(),
    ]);
    renderChatTabs();
    if (historyRendered) scrollChatToBottom({ force: true });
  } else if (options.reload !== false) {
    await reloadCurrentPage({ agentId: tab.agentId || '' });
  }
}

async function openChatSession(rawTab: Partial<WebuiChatTab>, options: { navigate?: boolean; loadHistory?: boolean; reload?: boolean; toast?: boolean } = {}) {
  const tab = upsertChatTab(rawTab, { activate: true });
  if (!tab) return;
  renderChatTabs();
  await activateChatTabSession(tab, options);
}

async function ensureActiveChatTabSelected() {
  ensureChatTabs();
  const tab = activeChatTab();
  if (!tab) {
    syncCurrentSessionChatTab({ activate: true });
    return false;
  }
  if (currentSnapshotMatchesChatTab(tab)) {
    renderChatTabs();
    restoreActiveChatTabDraft();
    return false;
  }
  await activateChatTabSession(tab, { loadHistory: false, reload: false, toast: false });
  return true;
}

function chatTabWorking(tab: WebuiChatTab) {
  const peerId = tab.peerId || 'local';
  if (peerId === (state.selectedPeer || 'local')
    && state.localTurnThreadId === tab.threadId
    && (!tab.agentId || !state.localTurnAgentId || state.localTurnAgentId === tab.agentId)) return true;
  return (state.activeSessions?.sessions || []).some(session => {
    const sessionPeer = String(session.peerId || 'local');
    if (sessionPeer !== peerId) return false;
    if (String(session.threadId || '') !== tab.threadId) return false;
    if (tab.agentId && session.agentId && String(session.agentId) !== tab.agentId) return false;
    return session.status === 'running' || session.status === 'external' || Boolean(session.approvalRequired);
  });
}

function chatTabLabel(tab: WebuiChatTab) {
  return short(tab.sessionName || tab.title || tab.threadId, 42);
}

function chatTabMeta(tab: WebuiChatTab) {
  const peer = tab.peerId && tab.peerId !== 'local' ? (tab.peerName || headerTargetName(tab.peerId)) : '';
  return [peer, tab.agentLabel || tab.agentId || '', tab.model || ''].filter(Boolean).join(' · ');
}

function renderChatTabs() {
  const root = document.getElementById('chatTabs');
  if (!root) return;
  const tabs = ensureChatTabs().filter(tab => tab.threadId);
  state.chatTabs = tabs;
  if (tabs.length <= 1) {
    root.hidden = true;
    root.innerHTML = '';
    writeChatTabs();
    return;
  }
  root.hidden = false;
  root.innerHTML = tabs.map(tab => {
    const selected = tab.id === state.activeChatTabId;
    const working = chatTabWorking(tab);
    const mainClass = working ? 'chat-tab-main' : 'chat-tab-main no-spinner';
    return '<div class="chat-tab" role="tab" aria-selected="' + (selected ? 'true' : 'false') + '" data-chat-tab="' + attr(tab.id) + '" title="' + attr([tab.threadId, tab.workspace].filter(Boolean).join(' | ')) + '">'
      + '<button type="button" class="' + mainClass + '" data-chat-tab-switch="' + attr(tab.id) + '">'
      + (working ? '<span class="chat-tab-spinner" aria-hidden="true"></span>' : '')
      + '<span class="chat-tab-label">' + esc(chatTabLabel(tab)) + '</span>'
      + '<small>' + esc(chatTabMeta(tab) || shortMiddle(tab.threadId)) + '</small>'
      + '</button>'
      + '<button type="button" class="chat-tab-close" data-chat-tab-close="' + attr(tab.id) + '" title="Close chat tab" aria-label="Close chat tab">&times;</button>'
      + '</div>';
  }).join('');
  bindChatTabs(root);
  writeChatTabs();
}

function closeChatTab(tabId: string) {
  const tabs = ensureChatTabs();
  const index = tabs.findIndex(tab => tab.id === tabId);
  if (index < 0) return;
  const wasActive = state.activeChatTabId === tabId;
  tabs.splice(index, 1);
  if (wasActive) {
    const next = tabs[Math.max(0, Math.min(index, tabs.length - 1))] || tabs[0] || null;
    state.activeChatTabId = next?.id || '';
    writeChatTabs();
    renderChatTabs();
    if (next) void safe(() => activateChatTabSession(next, { navigate: false }));
    else syncCurrentSessionChatTab({ activate: true });
    return;
  }
  writeChatTabs();
  renderChatTabs();
}

function bindChatTabs(root: ParentNode = document) {
  root.querySelectorAll?.<HTMLElement>('[data-chat-tab-switch]').forEach(button => button.onclick = event => safe(async () => {
    event.preventDefault();
    event.stopPropagation();
    const tab = ensureChatTabs().find(item => item.id === button.dataset.chatTabSwitch);
    if (tab) await activateChatTabSession(tab, { navigate: false });
  }, event));
  root.querySelectorAll?.<HTMLElement>('[data-chat-tab-close]').forEach(button => button.onclick = event => {
    event.preventDefault();
    event.stopPropagation();
    closeChatTab(button.dataset.chatTabClose || '');
  });
}

bindPromptDraftPersistence();
