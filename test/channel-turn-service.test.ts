import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CODEX_AGENT_CAPABILITIES, type AgentSessionService } from "../src/agents/shared/agent.js";
import { ChannelTurnService } from "../src/channels/shared/channel-turn-service.js";
import { toPromptEnvelope } from "../src/state/prompt-store.js";
import { WebChatStore, type WebActivityEvent } from "../src/web/web-state.js";
import type { AuditEvent } from "../src/access/audit-log.js";
import type { RelayArtifactService } from "../src/runtime/relay-artifact-service.js";
import type { RelayEvent, WebTaskDto } from "../src/runtime/relay-runtime-types.js";

describe("ChannelTurnService", () => {
  it("stores full prompt text and separate attachment metadata for web chat", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-turn-chat-"));
    try {
      const chatStore = new WebChatStore(workspace, "json", 10);
      const events: RelayEvent[] = [];
      let progress: WebTaskDto | null = null;
      let currentTurnStartedAt = Date.now();
      let accumulatedText = "";
      const longPrompt = "Schau dir das beigefügte Bild an und prüfe, warum die Diagnostics Seite an dieser Stelle falsch dargestellt wird.";
      const envelope = toPromptEnvelope({
        text: longPrompt,
        imagePaths: ["/tmp/screenshot.png"],
        stagedFileInstructions: "Attached files are available on disk.",
      });
      envelope.attachments = [{
        id: "screenshot.png",
        kind: "image",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 12345,
        turnId: "turn-upload",
      }];

      const service = new ChannelTurnService({
        source: "web",
        contextKey: "web:dashboard",
        chatStore,
        artifactService: {
          persistWorkspaceArtifactsForTurn: async () => undefined,
        } as unknown as RelayArtifactService,
        checkAuth: async () => ({ authenticated: true, detail: "ok" }),
        ensureActiveThread: async () => undefined,
        updateSession: () => undefined,
        appendActivity: (input) => ({ id: "activity", timestamp: new Date().toISOString(), ...input }) as WebActivityEvent,
        appendAudit: (input) => ({ id: "audit", timestamp: new Date().toISOString(), channelId: "web", ...input }) as AuditEvent,
        broadcast: (event) => events.push(event),
        chatHistory: async () => chatStore.list("thread-1"),
        setLastPrompt: () => undefined,
        getCurrentProgress: () => progress,
        setCurrentProgress: (next) => { progress = next; },
        setCurrentTurn: (_id, startedAt, text) => {
          currentTurnStartedAt = startedAt ?? Date.now();
          accumulatedText = text ?? "";
        },
        getCurrentTurnStartedAt: () => currentTurnStartedAt,
        getAccumulatedText: () => accumulatedText,
        setAccumulatedText: (text) => { accumulatedText = text; },
      });

      await service.run(fakeSession(), envelope);

      const userMessage = chatStore.list("thread-1").find((message) => message.role === "user");
      expect(userMessage).toMatchObject({
        text: longPrompt,
        meta: ["1 image", "staged file input"],
        attachments: envelope.attachments,
      });
      const turnStart = events.find((event) => event.type === "turn_start");
      expect(turnStart).toMatchObject({
        messageId: userMessage?.id,
        prompt: expect.stringContaining("1 image"),
        text: longPrompt,
        meta: ["1 image", "staged file input"],
        attachments: envelope.attachments,
        contextKey: "web:dashboard",
        agentId: "codex",
        threadId: "thread-1",
        workspace: "/repo",
      });
      expect(events.find((event) => event.type === "text_delta")).toMatchObject({
        contextKey: "web:dashboard",
        agentId: "codex",
        threadId: "thread-1",
        workspace: "/repo",
      });
      expect(events.find((event) => event.type === "turn_complete")).toMatchObject({
        contextKey: "web:dashboard",
        agentId: "codex",
        threadId: "thread-1",
        workspace: "/repo",
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("reattaches changed session state before running a prompt", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-turn-sync-"));
    try {
      const chatStore = new WebChatStore(workspace, "json", 10);
      const updateSession = vi.fn();
      const syncFromAgentState = vi.fn(() => ({
        threadId: "thread-1",
        changed: true,
        reattached: true,
        changedFields: ["launch"],
        info: fakeSession().getInfo(),
      }));
      const prompt = vi.fn(async (_input, callbacks) => {
        callbacks.onTextDelta("done");
        callbacks.onAgentEnd();
      });
      let progress: WebTaskDto | null = null;
      let currentTurnStartedAt = Date.now();
      let accumulatedText = "";
      const session = fakeSession({ syncFromAgentState, prompt });
      const service = new ChannelTurnService({
        source: "web",
        contextKey: "web:dashboard",
        chatStore,
        artifactService: {
          persistWorkspaceArtifactsForTurn: async () => undefined,
        } as unknown as RelayArtifactService,
        checkAuth: async () => ({ authenticated: true, detail: "ok" }),
        ensureActiveThread: async () => undefined,
        updateSession,
        appendActivity: (input) => ({ id: "activity", timestamp: new Date().toISOString(), ...input }) as WebActivityEvent,
        appendAudit: (input) => ({ id: "audit", timestamp: new Date().toISOString(), channelId: "web", ...input }) as AuditEvent,
        broadcast: () => undefined,
        chatHistory: async () => chatStore.list("thread-1"),
        setLastPrompt: () => undefined,
        getCurrentProgress: () => progress,
        setCurrentProgress: (next) => { progress = next; },
        setCurrentTurn: (_id, startedAt, text) => {
          currentTurnStartedAt = startedAt ?? Date.now();
          accumulatedText = text ?? "";
        },
        getCurrentTurnStartedAt: () => currentTurnStartedAt,
        getAccumulatedText: () => accumulatedText,
        setAccumulatedText: (text) => { accumulatedText = text; },
      });

      await service.run(session, toPromptEnvelope("continue"));

      expect(syncFromAgentState).toHaveBeenCalledWith({ reattach: true });
      expect(updateSession).toHaveBeenCalledWith(session);
      expect(prompt).toHaveBeenCalledOnce();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("uses the actor channel as the stored chat source for proxied turns", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-turn-source-"));
    try {
      const chatStore = new WebChatStore(workspace, "json", 10);
      const events: RelayEvent[] = [];
      let progress: WebTaskDto | null = null;
      let currentTurnStartedAt = Date.now();
      let accumulatedText = "";
      const prompt = vi.fn(async (_input, callbacks) => {
        callbacks.onTextDelta("done");
        callbacks.onAgentEnd();
      });
      const service = new ChannelTurnService({
        source: "web",
        contextKey: "peer:telegram-topic",
        chatStore,
        artifactService: {
          persistWorkspaceArtifactsForTurn: async () => undefined,
        } as unknown as RelayArtifactService,
        checkAuth: async () => ({ authenticated: true, detail: "ok" }),
        ensureActiveThread: async () => undefined,
        updateSession: () => undefined,
        appendActivity: (input) => ({ id: "activity", timestamp: new Date().toISOString(), ...input }) as WebActivityEvent,
        appendAudit: (input) => ({ id: "audit", timestamp: new Date().toISOString(), channelId: "web", ...input }) as AuditEvent,
        broadcast: (event) => events.push(event),
        chatHistory: async () => chatStore.list("thread-1"),
        setLastPrompt: () => undefined,
        getCurrentProgress: () => progress,
        setCurrentProgress: (next) => { progress = next; },
        setCurrentTurn: (_id, startedAt, text) => {
          currentTurnStartedAt = startedAt ?? Date.now();
          accumulatedText = text ?? "";
        },
        getCurrentTurnStartedAt: () => currentTurnStartedAt,
        getAccumulatedText: () => accumulatedText,
        setAccumulatedText: (text) => { accumulatedText = text; },
      });
      const envelope = toPromptEnvelope("continue");
      envelope.activityActor = { channel: "telegram", label: "Telegram user" };

      await service.run(fakeSession({ prompt }), envelope);

      expect(chatStore.list("thread-1").map((message) => message.source)).toEqual(["telegram", "telegram"]);
      expect(events.find((event) => event.type === "turn_start")).toMatchObject({ source: "telegram" });
      expect(progress?.source).toBe("telegram");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("broadcasts assistant message completion before the turn is fully finalized", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-turn-assistant-complete-"));
    try {
      const chatStore = new WebChatStore(workspace, "json", 10);
      const events: RelayEvent[] = [];
      let progress: WebTaskDto | null = null;
      let currentTurnStartedAt = Date.now();
      let accumulatedText = "";
      const prompt = vi.fn(async (_input, callbacks) => {
        callbacks.onTextDelta("done");
        callbacks.onAssistantMessageComplete?.();
        callbacks.onAgentEnd();
      });
      const service = new ChannelTurnService({
        source: "web",
        contextKey: "web:dashboard",
        chatStore,
        artifactService: {
          persistWorkspaceArtifactsForTurn: async () => undefined,
        } as unknown as RelayArtifactService,
        checkAuth: async () => ({ authenticated: true, detail: "ok" }),
        ensureActiveThread: async () => undefined,
        updateSession: () => undefined,
        appendActivity: (input) => ({ id: "activity", timestamp: new Date().toISOString(), ...input }) as WebActivityEvent,
        appendAudit: (input) => ({ id: "audit", timestamp: new Date().toISOString(), channelId: "web", ...input }) as AuditEvent,
        broadcast: (event) => events.push(event),
        chatHistory: async () => chatStore.list("thread-1"),
        setLastPrompt: () => undefined,
        getCurrentProgress: () => progress,
        setCurrentProgress: (next) => { progress = next; },
        setCurrentTurn: (_id, startedAt, text) => {
          currentTurnStartedAt = startedAt ?? Date.now();
          accumulatedText = text ?? "";
        },
        getCurrentTurnStartedAt: () => currentTurnStartedAt,
        getAccumulatedText: () => accumulatedText,
        setAccumulatedText: (text) => { accumulatedText = text; },
      });

      await service.run(fakeSession({ prompt }), toPromptEnvelope("continue"));

      const eventTypes = events.map((event) => event.type);
      expect(eventTypes).toContain("assistant_message_complete");
      expect(eventTypes.indexOf("assistant_message_complete")).toBeLessThan(eventTypes.indexOf("turn_complete"));
      expect(events.find((event) => event.type === "assistant_message_complete")).toMatchObject({
        correlationId: expect.any(String),
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("stores completed assistant message segments as separate chat messages", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-turn-segments-"));
    try {
      const chatStore = new WebChatStore(workspace, "json", 10);
      const events: RelayEvent[] = [];
      let progress: WebTaskDto | null = null;
      let currentTurnStartedAt = Date.now();
      let accumulatedText = "";
      const prompt = vi.fn(async (_input, callbacks) => {
        callbacks.onTextDelta("first segment");
        callbacks.onAssistantMessageComplete?.();
        callbacks.onTextDelta("second segment");
        callbacks.onAssistantMessageComplete?.();
        callbacks.onAgentEnd();
      });
      const service = new ChannelTurnService({
        source: "web",
        contextKey: "web:dashboard",
        chatStore,
        artifactService: {
          persistWorkspaceArtifactsForTurn: async () => undefined,
        } as unknown as RelayArtifactService,
        checkAuth: async () => ({ authenticated: true, detail: "ok" }),
        ensureActiveThread: async () => undefined,
        updateSession: () => undefined,
        appendActivity: (input) => ({ id: "activity", timestamp: new Date().toISOString(), ...input }) as WebActivityEvent,
        appendAudit: (input) => ({ id: "audit", timestamp: new Date().toISOString(), channelId: "web", ...input }) as AuditEvent,
        broadcast: (event) => events.push(event),
        chatHistory: async () => chatStore.list("thread-1"),
        setLastPrompt: () => undefined,
        getCurrentProgress: () => progress,
        setCurrentProgress: (next) => { progress = next; },
        setCurrentTurn: (_id, startedAt, text) => {
          currentTurnStartedAt = startedAt ?? Date.now();
          accumulatedText = text ?? "";
        },
        getCurrentTurnStartedAt: () => currentTurnStartedAt,
        getAccumulatedText: () => accumulatedText,
        setAccumulatedText: (text) => { accumulatedText = text; },
      });

      await service.run(fakeSession({ prompt }), toPromptEnvelope("continue"));

      const agentMessages = chatStore.list("thread-1").filter((message) => message.role === "agent");
      expect(agentMessages.map((message) => message.text)).toEqual(["first segment", "second segment"]);
      expect(agentMessages.find((message) => message.text === "first segmentsecond segment")).toBeUndefined();
      expect(events.filter((event) => event.type === "chat_message_added" && event.message.role === "agent")).toHaveLength(2);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

function fakeSession(overrides: Partial<AgentSessionService> = {}): AgentSessionService {
  return {
    getInfo: () => ({
      agentId: "codex",
      agentLabel: "Codex",
      threadId: "thread-1",
      workspace: "/repo",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      fastMode: false,
      unsafeLaunch: false,
      capabilities: { ...CODEX_AGENT_CAPABILITIES, auth: false },
    }),
    isProcessing: () => false,
    getActiveThreadId: () => "thread-1",
    hasActiveThread: () => true,
    getCurrentWorkspace: () => "/repo",
    prompt: async (_input, callbacks) => {
      callbacks.onTextDelta("done");
      callbacks.onAgentEnd();
    },
    abort: async () => undefined,
    newThread: async () => fakeSession().getInfo(),
    resumeThread: async () => fakeSession().getInfo(),
    switchSession: async () => fakeSession().getInfo(),
    listAllSessions: () => [],
    listWorkspaces: () => ["/repo"],
    refreshModels: async () => undefined,
    listModels: () => [],
    listLaunchProfiles: () => [],
    getSessionRecord: () => null,
    setModel: (slug) => slug,
    setModelForCurrentSession: (slug) => ({ ok: true, message: slug }),
    setReasoningEffort: () => undefined,
    setReasoningEffortForCurrentSession: (effort) => ({ ok: true, message: effort }),
    setLaunchProfile: (profileId) => ({
      id: profileId,
      label: profileId,
      behavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafe: false,
    }),
    setFastMode: (enabled) => ({ enabled, message: enabled ? "on" : "off" }),
    getSelectedLaunchProfile: () => ({
      id: "default",
      label: "Default",
      behavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafe: false,
    }),
    syncFromAgentState: () => ({ threadId: "thread-1", changed: false, reattached: false, changedFields: [], info: fakeSession().getInfo() }),
    handback: () => ({ ok: true, message: "ok" }),
    dispose: () => undefined,
    ...overrides,
  } as AgentSessionService;
}
