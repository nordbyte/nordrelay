type WebuiTimer = ReturnType<typeof setTimeout>;
type WebuiInterval = ReturnType<typeof setInterval>;
type WebuiRecord = Record<string, unknown>;
type WebuiRows = readonly (readonly unknown[])[];
type WebApiPath = import("./api-client-types.js").WebApiPath;
type WebApiClientOptions<P extends WebApiPath = WebApiPath> = import("./api-client-types.js").WebApiClientOptions<P>;

interface WebuiPager {
  page?: number;
  pageSize?: number;
  cursor?: string | null;
  nextCursor?: string | null;
  hasNext?: boolean;
  total?: number;
  reset(): void;
  render(meta?: WebuiRecord | null): void;
}

interface WebuiModelOption {
  slug?: string;
  displayName?: string;
  contextWindow?: number;
  supportsImages?: boolean;
  supportsThinking?: boolean;
}

interface WebuiLaunchProfile {
  id?: string;
  label?: string;
  behavior?: string;
  unsafe?: boolean;
}

interface WebuiCapabilities {
  modelSelection?: boolean;
  reasoningSelection?: boolean;
  launchProfiles?: boolean;
  fastMode?: boolean;
  [key: string]: unknown;
}

interface WebuiControls extends WebuiRecord {
  models?: WebuiModelOption[];
  reasoningOptions?: string[];
  launchProfiles?: WebuiLaunchProfile[];
  workspaces?: string[];
  capabilities?: WebuiCapabilities;
  reasoningLabel?: string;
}

interface WebuiSessionSnapshot extends WebuiRecord {
  agentId?: string;
  agentLabel?: string;
  threadId?: string;
  sessionName?: string;
  workspace?: string;
  model?: string;
  reasoning?: string;
  fastMode?: boolean;
}

interface WebuiSnapshot extends WebuiRecord {
  session?: WebuiSessionSnapshot | null;
  workspaces?: string[];
  queue?: WebuiRecord[];
  queuePaused?: boolean;
}

interface WebuiAuth extends WebuiRecord {
  csrfToken?: string;
  permissions?: string[];
}

type WebuiApiStateStatus = "online" | "restarting" | "auth-expired" | "peer-unreachable" | "stale-data" | "offline";

interface WebuiApiStateEntry extends WebuiRecord {
  status: WebuiApiStateStatus;
  target: string;
  message?: string;
  lastOkAt?: string;
  updatedAt?: string;
  retryAt?: string;
  staleSince?: string;
  consecutiveFailures?: number;
}

interface WebuiApiStatusState extends WebuiRecord {
  local: WebuiApiStateEntry;
  peers: Record<string, WebuiApiStateEntry>;
}

interface WebuiApiStateTransition extends WebuiRecord {
  target?: string;
  message?: string;
  retryAfterMs?: number;
  incrementFailure?: boolean;
  statusCode?: number;
  path?: string;
  method?: string;
}

interface WebuiApiRequestContext extends WebuiRecord {
  target?: string;
  path?: string;
  method?: WebApiMethod;
  proxied?: boolean;
}

interface WebuiBootstrap extends WebuiRecord {
  auth?: WebuiAuth | null;
  controls?: WebuiControls;
  enabledAgents?: string[];
  status?: { snapshot?: WebuiSnapshot };
}

interface WebuiAccessGroup extends WebuiRecord {
  id: string;
  name?: string;
  description?: string;
  permissions?: string[];
  system?: boolean;
  agentIds?: string[];
  workspaceRoots?: string[];
  peerIds?: string[];
  matrixRoomIds?: string[];
}

interface WebuiChannelRecord extends WebuiRecord {
  id?: string;
  title?: string;
  channelId: string;
  guildId?: string;
  teamId?: string;
  roomId?: string;
  type?: string;
  enabled?: boolean;
  allowedGroupIds?: string[];
}

interface WebuiUserRecord extends WebuiRecord {
  id: string;
  email?: string;
  displayName?: string;
  active?: boolean;
  groups?: WebuiAccessGroup[];
  webSessions?: WebuiRecord[];
}

interface WebuiUserManagement extends WebuiRecord {
  users?: WebuiUserRecord[];
  groups?: WebuiAccessGroup[];
  permissions?: string[];
  telegramChats?: WebuiChannelRecord[];
  discordChannels?: WebuiChannelRecord[];
  slackChannels?: WebuiChannelRecord[];
  matrixRooms?: WebuiChannelRecord[];
}

interface WebuiActorRecord extends WebuiRecord {
  id?: string | number;
  label?: string;
  username?: string;
  channel?: string;
  channelUserId?: string | number;
}

interface WebuiAuditEvent extends WebuiRecord {
  actor?: WebuiActorRecord;
  actorId?: string | number;
  timestamp?: string;
  channelId?: string;
  status?: string;
  category?: string;
  action?: string;
  contextKey?: string;
  agentId?: string;
  threadId?: string;
  workspace?: string;
  description?: string;
  detail?: string;
}

interface WebuiActiveSession extends WebuiRecord {
  agentId?: string;
  threadId?: string;
  workspace?: string;
  status?: string;
  source?: string;
  startedAt?: string;
  prompt?: string;
  approvalRequired?: WebuiRecord | null;
}

interface WebuiChatMessage extends WebuiRecord {
  id?: string;
  source?: string;
  timestamp?: string;
  text?: string;
  meta?: WebuiRecord[];
  attachments?: WebuiChatAttachment[];
  actions?: WebuiRecord[];
  actionResolution?: WebuiRecord | null;
}

interface WebuiChatAttachment extends WebuiRecord {
  id?: string;
  kind?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  turnId?: string;
}

interface WebuiChatTab extends WebuiRecord {
  id: string;
  peerId: string;
  peerName?: string;
  agentId?: string;
  agentLabel?: string;
  threadId: string;
  sessionName?: string;
  title?: string;
  workspace?: string;
  model?: string;
  draft?: string;
  openedAt: string;
  lastActiveAt: string;
}

interface WebuiCursorPagination extends WebuiRecord {
  limit?: number;
  nextCursor?: string | null;
  hasNext?: boolean;
  total?: number;
}

interface WebuiActiveSessionsState extends WebuiRecord {
  sessions?: WebuiActiveSession[];
}

interface WebuiPeerRecord extends WebuiRecord {
  id: string;
  name?: string;
  url?: string;
  enabled?: boolean;
  nodeId?: string;
  fingerprint?: string;
  tlsFingerprint?: string;
  trustStatus?: string;
  allowedAgents?: string[];
}

interface WebuiPeerState extends WebuiRecord {
  peers?: WebuiPeerRecord[];
  readiness?: { warnings?: string[] };
  invitations?: WebuiRecord[];
}

interface WebuiPeerProbeResult extends WebuiRecord {
  peerName?: string;
  probe?: {
    ok?: boolean;
    status?: string;
    url?: string;
    latencyMs?: number;
    statusCode?: number;
    tlsFingerprint?: string;
    detail?: string;
  };
  readiness?: WebuiRecord;
  type?: string;
  peerId?: string;
}

interface WebuiPeerTarget extends WebuiRecord {
  id: string;
  name: string;
  agents: string[];
  snapshot?: WebuiSnapshot | null;
  loading?: boolean;
  error?: string;
}

interface WebuiHeaderSessionRecord extends WebuiRecord {
  id: string;
  title?: string;
  firstUserMessage?: string;
  cwd?: string;
  model?: string;
  updatedAt?: string;
}

interface WebuiHeaderTarget extends WebuiRecord {
  id: string;
  name: string;
  agents: string[];
  snapshot?: WebuiSnapshot | null;
  loading?: boolean;
  error?: string;
}

interface WebuiIncrementalRenderToken {
  cancelled?: boolean;
}

interface WebuiSettingsWizardState extends WebuiRecord {
  home?: boolean;
  channel?: string;
  step?: number;
  values?: Record<string, string>;
  errors?: string[];
  testResult?: unknown;
}

interface WebuiWorkflowBuilderStep extends WebuiRecord {
  _uid?: string;
  id?: string;
  name?: string;
  source?: string;
  type?: string;
  prompt?: string;
  templateId?: string;
  workflowId?: string;
  pluginId?: string;
  pluginActionId?: string;
  pluginInput?: Record<string, unknown>;
  pluginInputJson?: string;
  pluginOutputVariables?: Record<string, string>;
  pluginOutputVariablesJson?: string;
  condition?: {
    variable?: string;
    operator?: string;
    value?: string;
  };
  retryPolicy?: {
    maxAttempts?: number;
    delayMs?: number;
  };
  conditionVariable?: string;
  conditionOperator?: string;
  conditionValue?: string;
  retryAttempts?: number;
  retryDelayMs?: number;
  agentId?: string;
  workspace?: string;
  workspaceMode?: string;
  model?: string;
  reasoningEffort?: string;
  launchProfileId?: string;
  sessionMode?: string;
  threadId?: string;
  target?: string;
  requiresApproval?: boolean;
  continueOnError?: boolean;
}

interface WebuiWorkflowBuilderState extends WebuiRecord {
  workflowId?: string;
  steps?: WebuiWorkflowBuilderStep[];
}

interface WebuiQueuePlannerState extends WebuiRecord {
  plans?: WebuiRecord[];
}

interface WebuiWorktreesState extends WebuiRecord {
  integrations?: WebuiRecord[];
  records?: WebuiRecord[];
}

interface WebuiArtifactFile extends WebuiRecord {
  name: string;
  relativePath: string;
  sizeBytes: number;
  safeStatus?: string;
  safeWarnings?: string[];
}

interface WebuiArtifactReport extends WebuiRecord {
  turnId: string;
  artifacts?: WebuiArtifactFile[];
  fileCount?: number;
  totalSizeBytes?: number;
  updatedAt?: string;
  provenance?: WebuiRecord;
  source?: string;
}

interface WebuiSettingRecord extends WebuiRecord {
  key?: string;
  group?: string;
  help?: string;
  configured?: boolean;
  value?: string;
  effectiveValue?: string;
  kind?: string;
  options?: string[];
}

type WebuiSettingsGroupMap = Record<string, WebuiSettingRecord[]>;
type WebuiStringMap = Record<string, string>;

interface WebuiToastOptions {
  duration?: number;
  sticky?: boolean;
}

interface WebuiPersistOptions {
  persist?: boolean;
}

interface WebuiReloadPageOptions {
  agentId?: string;
}

interface WebuiLoadVersionOptions {
  quiet?: boolean;
  refreshJobs?: boolean;
  forceRefresh?: boolean;
}

interface WebuiChatScrollOptions {
  force?: boolean;
}

interface WebuiAppendMessageOptions extends WebuiRecord {
  meta?: WebuiRecord[];
  attachments?: WebuiChatAttachment[];
  messageId?: string;
  forceScroll?: boolean;
}

interface WebuiRenderChatOptions {
  forceScroll?: boolean;
  preserveScrollOffset?: boolean;
}

interface WebuiLoadChatHistoryOptions extends WebuiRenderChatOptions {
  skipIfRendered?: boolean;
}

interface WebuiAccessFilters {
  query: string;
  status: string;
  group: string;
  identity: string;
}

interface DashboardState {
  snapshot: WebuiSnapshot | null;
  controls: WebuiControls | null;
  newSessionControls: WebuiControls | null;
  enabledAgents: string[];
  auth: WebuiAuth | null;
  profile: WebuiRecord | null;
  csrfToken: string | null;
  apiStatus: WebuiApiStatusState;
  authReloading: boolean;
  permissions: string[];
  settings: WebuiSettingRecord[];
  settingsDraft: Record<string, string>;
  settingsErrors: Record<string, unknown>;
  settingsSearch: string;
  settingsOpenCategories: Record<string, boolean>;
  currentPage: string;
  settingsGroup: string | null;
  settingsWizard: WebuiSettingsWizardState | null;
  accessTab: string;
  adapterTab: string;
  pluginTab?: string;
  peerTab: string;
  workflowTab: string;
  queueTab: string;
  sessionTab: string;
  monitorTab: string;
  diagnosticsTab: string;
  queuePlanner: WebuiQueuePlannerState | null;
  workflowTemplates: WebuiRecord[];
  workflows: WebuiRecord[];
  workflowRuns: WebuiRecord[];
  logsPlain: string;
  logTimer: WebuiTimer | null;
  logSearchTimer?: WebuiTimer | null;
  toastTimer: WebuiTimer | null;
  stickyToastActive: boolean;
  stickyToastText: string;
  cliStatusActive: boolean;
  webMirror: WebuiRecord | null;
  selectedArtifactTurns: Set<string>;
  mediaRecorder: MediaRecorder | null;
  recordedChunks: Blob[];
  events: EventSource | null;
  reconnectTimer: WebuiTimer | null;
  notifications: boolean;
  completionSound: boolean;
  completionSoundAudioContext: AudioContext | null;
  completionSoundArmedKey: string | null;
  toolTooltipTimer: WebuiTimer | null;
  toolTooltipTarget: Element | null;
  toolsVisible: boolean;
  themePreference: string | null;
  agentUpdateJobs: WebuiRecord[];
  versionRequestId: number;
  sessionsRequestId: number;
  sessionAgeTimer: WebuiInterval | null;
  activityAgeTimer: WebuiInterval | null;
  chatWorkingTimer: WebuiInterval | null;
  sessionDetailRefreshTimer: WebuiInterval | null;
  sessionDetailAgeTimer: WebuiInterval | null;
  sessionDetailThreadId: string | null;
  sessionDetailAgentId: string | null;
  sessionDetailPeerId: string | null;
  sessionDetailRequestId: number;
  chatHistoryRequestId: number;
  chatRenderVersion: number;
  chatHistoryPagination: WebuiCursorPagination | null;
  chatHistoryLoadingOlder: boolean;
  chatTabs: WebuiChatTab[];
  activeChatTabId: string;
  activeSessions: WebuiActiveSessionsState | null;
  activeSessionsTimer: WebuiInterval | null;
  activeSessionDurationTimer: WebuiInterval | null;
  activeSessionsLoading: boolean;
  activeSessionsLastLoadAt: number;
  activeSessionsPeerBackoff: Record<string, number>;
  activeSessionsTarget: string;
  activeSessionsErrors?: WebuiRecord[];
  activeSessionsLoadedTarget?: string;
  currentSessions?: WebuiRecord[];
  localTurnThreadId: string | null;
  localTurnAgentId: string | null;
  localTurnPeerId: string | null;
  localTurnStartedAt: string | null;
  peers: WebuiPeerState | null;
  peerRelay: WebuiRecord | null;
  peerRefreshTimer: WebuiInterval | null;
  peerInviteSecrets: Record<string, { code: string; command: string }>;
  peerProbeResult: WebuiPeerProbeResult | null;
  peerDiscoveryJobs: WebuiRecord[];
  incrementalRenders: Record<string, WebuiIncrementalRenderToken>;
  selectedPeer: string;
  activePeerDiscoveryJobId?: string;
  peerTargets?: WebuiPeerTarget[];
  adapterConformance?: WebuiRecord | null;
  plugins?: WebuiRecord[];
  pluginCatalog?: WebuiRecord | null;
  pluginUpdateChecks?: Record<string, WebuiRecord>;
  activityEvents?: WebuiRecord[];
  auditEvents?: WebuiAuditEvent[];
  logsEntries?: WebuiRecord[];
  chatMessages?: WebuiChatMessage[];
  artifactReports?: WebuiArtifactReport[];
  artifactUsage?: WebuiRecord | null;
  artifactSearchTimer?: WebuiTimer | null;
  metricsAutoRefresh?: boolean;
  metricsHistory?: WebuiRecord[];
  metricsLastData?: WebuiRecord | null;
  metricsObservability?: WebuiRecord | null;
  metricsLastUpdatedAt?: number | null;
  metricsTab?: string;
  localBootstrap?: WebuiBootstrap | null;
  userManagement?: WebuiUserManagement | null;
  userFilters?: WebuiAccessFilters;
  userPage?: number;
  userPageSize?: number;
  activeUserDetailId?: string;
  userDetailAudit?: Record<string, WebuiRecord[]>;
  workflowBuilder?: WebuiWorkflowBuilderState | null;
  worktrees?: WebuiWorktreesState | null;
  worktreeConflictResolutions?: WebuiRecord[];
  worktreeReviewIds?: string[];
  compactControlOutsideBound?: boolean;
  templatePickerOutsideBound?: boolean;
}

interface AdminDialogOptions {
  submitText?: string;
  afterSubmit?: () => unknown | Promise<unknown>;
  reloadAccess?: boolean;
}

interface UiButtonOptions {
  className?: string;
  attrs?: string;
  permission?: string;
  icon?: string;
  title?: unknown;
  summary?: string;
  disabled?: boolean;
  variant?: string;
  mini?: boolean;
  data?: Record<string, unknown>;
}

interface UiCardOptions {
  badge?: { text: string; status?: string } | null;
  className?: string;
}

interface UiItemOptions {
  badge?: { text: string; status?: string } | null;
  rows?: WebuiRows;
  actions?: string;
  body?: string;
  className?: string;
  title?: unknown;
  titleHtml?: string;
}

interface RenderIncrementalOptions<T> {
  key: string;
  emptyText?: string;
  emptyHtml?: string;
  prefixHtml?: string;
  suffixHtml?: string;
  bodyTag?: string;
  tableClass?: string;
  tableClassHtml?: string;
  wrapClass?: string;
  headHtml?: string;
  renderItem: (item: T, index?: number) => string;
  initialCount?: number;
  batchSize?: number;
  maxRenderRows?: number;
  onBatch?: (root: Element | Document, rendered: number, total: number) => void;
  onDone?: (root?: Element | Document) => void;
}
