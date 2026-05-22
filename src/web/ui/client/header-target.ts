function localHeaderTarget(local: WebuiBootstrap): WebuiHeaderTarget {
  return { id: 'local', name: 'Local node', agents: local.enabledAgents || [], snapshot: local.status?.snapshot || null, loading: false, error: '' };
}

function headerTargetName(peerId: string) {
  if (peerId === 'local') return 'Local node';
  const peer = (state.peers?.peers || []).find((p: WebuiPeerRecord) => p.id === peerId);
  return peer?.name || peerId;
}

function applyHeaderPeerSnapshot(peers: WebuiPeerState | null, local = state.localBootstrap) {
  const localTarget = localHeaderTarget(local || { enabledAgents: state.enabledAgents || [], status: { snapshot: state.snapshot } });
  state.peers = peers;
  const available = (peers?.peers || []).filter((p: WebuiPeerRecord) => p.enabled && p.url);
  if (state.selectedPeer !== 'local' && !available.some((p: WebuiPeerRecord) => p.id === state.selectedPeer)) state.selectedPeer = 'local';
  state.peerTargets = [localTarget].concat(available.map((p: WebuiPeerRecord) => ({ id: p.id, name: p.name || p.id, agents: p.allowedAgents || [], snapshot: null, loading: true, error: '' })));
}

async function loadHeaderTargetCandidates(local: WebuiBootstrap) {
  const localTarget = localHeaderTarget(local);
  if (!can('peers.read')) {
    state.selectedPeer = 'local';
    state.peerTargets = [localTarget];
    return;
  }
  try {
    const peers = await api('/api/peers', { local: true });
    applyHeaderPeerSnapshot(peers, local);
  } catch {
    state.peerTargets = [localTarget];
    state.selectedPeer = 'local';
  }
}

function mergeHeaderTargetBootstrap(peerId: string, bootstrap: WebuiBootstrap) {
  const targets = state.peerTargets || [];
  const index = targets.findIndex((t: WebuiHeaderTarget) => t.id === peerId);
  const entry = { id: peerId, name: headerTargetName(peerId), agents: bootstrap.enabledAgents || [], snapshot: bootstrap.status?.snapshot || null, loading: false, error: '' };
  if (index >= 0) targets[index] = { ...targets[index], ...entry };
  else targets.push(entry);
  state.peerTargets = targets;
}

async function refreshRemoteHeaderTargets(local: WebuiBootstrap, selectedData: WebuiBootstrap) {
  if (!can('peers.read')) return;
  const targets = (state.peerTargets || []).filter((t: WebuiHeaderTarget) => t.id !== 'local');
  if (!targets.length) return;
  await Promise.all(targets.map(async (target: WebuiHeaderTarget) => {
    try {
      const bootstrap = state.selectedPeer === target.id ? selectedData : await apiPeer(target.id, '/api/bootstrap');
      mergeHeaderTargetBootstrap(target.id, bootstrap);
    } catch (error) {
      const current = (state.peerTargets || []).find((t: WebuiHeaderTarget) => t.id === target.id);
      if (current) { current.loading = false; current.error = error instanceof Error ? error.message : String(error); }
    }
  }));
  renderHeaderTargetMenu(state.snapshot);
}

function renderHeaderTargetMenu(s = state.snapshot) {
  const line = document.getElementById('sessionLine');
  if (!line || !s?.session) return;
  const session = s.session;
  const thread = session.threadId || '';
  const summary = [session.agentLabel || session.agentId || 'Agent', session.model || 'default', headerSessionLabel(session)].join(' / ');
  const targets = state.peerTargets && state.peerTargets.length ? state.peerTargets : [{ id: state.selectedPeer || 'local', name: headerTargetName(state.selectedPeer || 'local'), agents: state.enabledAgents || [], snapshot: s, loading: false, error: '' }];
  const groups = targets.map((target: WebuiHeaderTarget) => headerTargetGroupHtml(target, session)).join('');
  line.innerHTML = '<div class="compact-control header-target-menu" data-header-target-menu><button type="button" id="headerTargetBtn" class="control-menu-button header-target-button" aria-haspopup="menu" aria-expanded="false" title="' + attr('Target: ' + headerTargetName(state.selectedPeer || 'local')) + '">' + esc(summary) + '</button><div class="control-menu-list header-target-list" role="menu" hidden>' + groups + '</div></div>' + (thread ? headerThreadCopyButton(thread) : '');
  bindHeaderTargetMenu(line);
  bindUiCopyButtons(line);
}

function headerSessionLabel(session: WebuiSessionSnapshot) {
  const name = String(session.sessionName || '').trim();
  if (name) return name;
  const thread = session.threadId || '';
  return thread ? shortMiddle(thread) : 'not started';
}

function headerThreadCopyButton(thread: string) {
  return '<button type="button" class="copy-id header-thread-copy" data-copy-value="' + attr(thread) + '" data-copy-label="Thread ID copied" title="Copy thread ID" aria-label="Copy thread ID"><span class="copy-icon" aria-hidden="true"></span></button>';
}

function headerTargetGroupHtml(target: WebuiHeaderTarget, currentSession: WebuiSessionSnapshot) {
  const selectedPeer = (state.selectedPeer || 'local') === target.id;
  const agents = target.agents || [];
  const selectedAgent = target.snapshot?.session?.agentId || currentSession.agentId;
  const status = target.error ? 'error' : target.loading ? 'loading' : '';
  const agentButtons = agents.length ? agents.map((agent: string) => headerTargetAgentHtml(target, agent, selectedPeer && selectedAgent === agent)).join('') : '<button type="button" class="header-target-agent" disabled>' + (target.loading ? 'Loading agents...' : target.error ? 'Unavailable' : 'No agents enabled') + '</button>';
  return '<div class="header-target-peer" data-target-peer="' + attr(target.id) + '"><div class="header-target-peer-title"><strong>' + esc(target.name || target.id) + '</strong>' + (selectedPeer ? '<span class="chip">selected peer</span>' : '') + (status ? '<small>' + esc(status) + '</small>' : '') + '</div>' + agentButtons + '</div>';
}

function headerTargetAgentHtml(target: WebuiHeaderTarget, agent: string, selected: boolean) {
  const snapshot = target.snapshot?.session;
  const model = snapshot && snapshot.agentId === agent ? (snapshot.model || 'default') : '';
  const thread = snapshot && snapshot.agentId === agent && snapshot.threadId ? headerSessionLabel(snapshot) : '';
  const meta = [model, thread].filter(Boolean).join(' / ');
  const key = headerTargetSessionKey(target.id, agent);
  return '<div class="header-target-agent-block" data-target-agent-block="' + attr(key) + '"><div class="header-target-agent-row"><button type="button" role="menuitemradio" class="header-target-agent" data-target-peer="' + attr(target.id) + '" data-target-agent="' + attr(agent) + '" aria-selected="' + (selected ? 'true' : 'false') + '"' + disabledAttr('sessions.write') + '><span>' + esc(agent) + '</span>' + (meta ? '<small>' + esc(meta) + '</small>' : '') + '</button><button type="button" class="header-target-session-toggle" data-target-sessions-toggle="' + attr(key) + '" data-target-peer="' + attr(target.id) + '" data-target-agent="' + attr(agent) + '" aria-expanded="false" title="Show recent sessions" aria-label="Show recent ' + attr(agent) + ' sessions"' + disabledAttr('sessions.read') + '><span aria-hidden="true"></span></button></div><div class="header-target-sessions" data-target-sessions="' + attr(key) + '" hidden></div></div>';
}

function headerTargetSessionKey(peerId: string, agentId: string) { return String(peerId || 'local') + '::' + String(agentId || ''); }

function bindHeaderTargetMenu(root: ParentNode = document) {
  const menu = root.querySelector?.('[data-header-target-menu]');
  const button = menu?.querySelector<HTMLButtonElement>('#headerTargetBtn');
  const list = menu?.querySelector<HTMLElement>('.header-target-list');
  if (button && list) button.onclick = event => { event.preventDefault(); event.stopPropagation(); const open = list.hidden; closeCompactControlMenus(menu); list.hidden = !open; button.setAttribute('aria-expanded', open ? 'true' : 'false'); };
  root.querySelectorAll?.<HTMLElement>('[data-target-agent]').forEach(option => option.onclick = event => safe(async () => {
    event.preventDefault(); event.stopPropagation();
    if (!can('sessions.write')) { toast('Permission required: sessions.write'); return; }
    await selectHeaderTarget(option.dataset.targetPeer || 'local', option.dataset.targetAgent || '');
  }, event));
  root.querySelectorAll?.<HTMLElement>('[data-target-sessions-toggle]').forEach(toggle => toggle.onclick = event => safe(async () => {
    event.preventDefault(); event.stopPropagation();
    if (!can('sessions.read')) { toast('Permission required: sessions.read'); return; }
    await toggleHeaderTargetSessions(toggle);
  }, event));
  root.querySelectorAll?.<HTMLElement>('[data-target-session-switch]').forEach(option => option.onclick = event => safe(async () => {
    event.preventDefault(); event.stopPropagation();
    if (!can('sessions.write')) { toast('Permission required: sessions.write'); return; }
    await selectHeaderTargetSession(option.dataset.targetPeer || 'local', option.dataset.targetAgent || '', option.dataset.targetSessionSwitch || '');
  }, event));
  root.querySelectorAll?.<HTMLElement>('[data-target-session-load-more]').forEach(button => button.onclick = event => safe(async () => {
    event.preventDefault(); event.stopPropagation();
    if (!can('sessions.read')) { toast('Permission required: sessions.read'); return; }
    const panel = button.closest<HTMLElement>('[data-target-sessions]');
    if (!panel) return;
    const nextPage = Number(button.dataset.targetSessionNextPage || '2');
    await loadHeaderTargetSessionsPage(panel, button.dataset.targetPeer || 'local', button.dataset.targetAgent || '', nextPage);
  }, event));
}

async function headerTargetRequest(peerId: string, requestPath: WebApiPath, options: WebApiClientOptions = {}) {
  return peerId === 'local' ? api(requestPath, { ...options, local: true }) : apiPeer(peerId, requestPath, options);
}

async function selectHeaderTarget(peerId: string, agentId: string) {
  const previousPeer = state.selectedPeer || 'local';
  const changedPeer = previousPeer !== peerId;
  state.selectedPeer = peerId || 'local';
  localStorage.setItem('nordrelayPeerTarget', state.selectedPeer);
  if (changedPeer) connectEvents();
  const selected = agentId;
  const r = await headerTargetRequest(state.selectedPeer, '/api/agent', { method: 'POST', body: JSON.stringify({ agentId: selected }) });
  if (state.snapshot && r.session) { state.snapshot.session = r.session; renderSnapshot(state.snapshot); }
  toast('Target switched to ' + headerTargetName(state.selectedPeer) + ' / ' + selected);
  await loadBootstrap(); await reloadCurrentPage({ agentId: selected });
}

async function selectHeaderTargetSession(peerId: string, agentId: string, threadId: string) {
  if (!threadId) return;
  const previousPeer = state.selectedPeer || 'local';
  const changedPeer = previousPeer !== peerId;
  state.selectedPeer = peerId || 'local';
  localStorage.setItem('nordrelayPeerTarget', state.selectedPeer);
  if (changedPeer) connectEvents();
  if (agentId) await headerTargetRequest(state.selectedPeer, '/api/agent', { method: 'POST', body: JSON.stringify({ agentId }) });
  const r = await headerTargetRequest(state.selectedPeer, '/api/sessions/switch', { method: 'POST', body: JSON.stringify({ threadId }) });
  if (state.snapshot && r.session) { state.snapshot.session = r.session; renderSnapshot(state.snapshot); }
  toast('Session switched');
  await loadBootstrap(); await reloadCurrentPage({ agentId });
}

async function toggleHeaderTargetSessions(toggle: HTMLElement) {
  const key = toggle.dataset.targetSessionsToggle;
  const panel = document.querySelector<HTMLElement>('[data-target-sessions="' + cssEscape(key || '') + '"]');
  if (!panel) return;
  const opening = panel.hidden;
  toggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
  panel.hidden = !opening;
  if (!opening) return;
  if (panel.dataset.loaded === 'true') return;
  const peerId = toggle.dataset.targetPeer || 'local';
  const agentId = toggle.dataset.targetAgent || '';
  panel.dataset.targetPeer = peerId;
  panel.dataset.targetAgent = agentId;
  panel.innerHTML = '<div class="header-target-session-state">Loading sessions...</div>';
  await loadHeaderTargetSessionsPage(panel, peerId, agentId, 1);
}

async function loadHeaderTargetSessionsPage(panel: HTMLElement, peerId: string, agentId: string, pageNumber: number) {
  try {
    const data = await headerTargetRequest(peerId, '/api/sessions', { query: { agent: agentId, page: pageNumber, limit: 5 } });
    const sessions = data.sessions || [];
    const hasNext = Boolean(data.pagination?.hasNext);
    panel.querySelector('[data-target-session-load-more]')?.remove();
    panel.dataset.loaded = 'true';
    panel.dataset.page = String(pageNumber);
    panel.dataset.hasNext = hasNext ? 'true' : 'false';
    if (pageNumber <= 1) panel.innerHTML = renderHeaderTargetSessions(peerId, agentId, sessions, hasNext, pageNumber + 1);
    else panel.insertAdjacentHTML('beforeend', renderHeaderTargetSessionItems(peerId, agentId, sessions) + headerTargetLoadMoreHtml(peerId, agentId, hasNext, pageNumber + 1));
    bindHeaderTargetMenu(panel);
  } catch (error) {
    panel.innerHTML = '<div class="header-target-session-state error">' + esc(error instanceof Error ? error.message : String(error)) + '</div>';
  }
}

function renderHeaderTargetSessions(peerId: string, agentId: string, sessions: WebuiHeaderSessionRecord[], hasNext = false, nextPage = 2) {
  if (!sessions.length) return '<div class="header-target-session-state">No recent sessions.</div>';
  return renderHeaderTargetSessionItems(peerId, agentId, sessions) + headerTargetLoadMoreHtml(peerId, agentId, hasNext, nextPage);
}

function renderHeaderTargetSessionItems(peerId: string, agentId: string, sessions: WebuiHeaderSessionRecord[]) {
  return sessions.slice(0, 5).map(session => {
    const title = session.title || session.firstUserMessage || session.id;
    const meta = [shortMiddle(session.id), session.model || '', session.cwd || '', session.updatedAt ? fmtSessionAge(session.updatedAt) + ' ago' : ''].filter(Boolean).join(' · ');
    return '<button type="button" class="header-target-session" data-target-session-switch="' + attr(session.id) + '" data-target-peer="' + attr(peerId) + '" data-target-agent="' + attr(agentId) + '" title="' + attr([title, session.id, session.cwd || '', fmtDate(session.updatedAt)].filter(Boolean).join(' | ')) + '"' + disabledAttr('sessions.write') + '><span>' + esc(short(title, 92)) + '</span><small>' + esc(short(meta, 140)) + '</small></button>';
  }).join('');
}

function headerTargetLoadMoreHtml(peerId: string, agentId: string, hasNext: boolean, nextPage: number) {
  return hasNext ? '<button type="button" class="header-target-load-more" data-target-session-load-more="true" data-target-peer="' + attr(peerId) + '" data-target-agent="' + attr(agentId) + '" data-target-session-next-page="' + attr(nextPage) + '"' + disabledAttr('sessions.read') + '>Load more</button>' : '';
}
