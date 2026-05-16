import type { Permission } from "./access-control.js";
import type { AuditEvent } from "./audit-log.js";
import type { ChannelContext } from "./channel-adapter.js";
import type { ChannelBusyState, ChannelQueueStatusState } from "./channel-bridge-state.js";
import type { ChannelContextKey } from "./context-key.js";
import type { UserStore, AuthenticatedUser } from "./user-management.js";
import type { WebActivityActor, WebActivityStore } from "./web-state.js";

export interface ChannelBridgeRequestBase {
  contextKey: ChannelContextKey;
  context: ChannelContext;
  authUser?: AuthenticatedUser;
}

export interface ChannelActorInput {
  id: string;
  label: string;
  username?: string;
  channelUserId?: string;
}

export interface ChannelAuditInput extends Omit<AuditEvent, "id" | "timestamp" | "channelId" | "contextKey"> {
  contextKey?: string;
}

export type ChannelActivityInput = Omit<Parameters<WebActivityStore["append"]>[0], "source" | "threadId" | "workspace"> & {
  threadId?: string | null;
  workspace?: string;
};

export function createChannelBusyStore<Key extends string, State extends ChannelBusyState = ChannelBusyState>(
  defaults: () => State = () => ({ processing: false, switching: false }) as State,
): {
  get(contextKey: Key): State;
  peek(contextKey: Key): State | undefined;
  delete(contextKey: Key): void;
} {
  const states = new Map<Key, State>();
  return {
    get(contextKey) {
      let state = states.get(contextKey);
      if (!state) {
        state = defaults();
        states.set(contextKey, state);
      }
      return state;
    },
    peek(contextKey) {
      return states.get(contextKey);
    },
    delete(contextKey) {
      states.delete(contextKey);
    },
  };
}

export function createChannelQueueStatusController<Key extends string, MessageId extends string | number>(options: {
  send(contextKey: Key, context: ChannelContext, text: string): Promise<MessageId>;
  edit(contextKey: Key, context: ChannelContext, messageId: MessageId, text: string): Promise<void>;
}): {
  update(contextKey: Key, context: ChannelContext, text: string): Promise<void>;
  delete(contextKey: Key): void;
} {
  const states = new Map<Key, ChannelQueueStatusState<MessageId>>();
  return {
    async update(contextKey, context, text) {
      const state = states.get(contextKey) ?? {};
      if (state.lastText === text && state.messageId) {
        return;
      }
      if (!state.messageId) {
        state.messageId = await options.send(contextKey, context, text);
        state.lastText = text;
        states.set(contextKey, state);
        return;
      }
      await options.edit(contextKey, context, state.messageId, text);
      state.lastText = text;
      states.set(contextKey, state);
    },
    delete(contextKey) {
      states.delete(contextKey);
    },
  };
}

export function createChannelActivityRecorder<Request extends ChannelBridgeRequestBase>(options: {
  source: "discord" | "slack";
  workspace: string;
  activityStore: WebActivityStore;
  actorFor(request: Request): WebActivityActor;
}): (request: Request, input: ChannelActivityInput) => void {
  return (request, input) => {
    options.activityStore.append({
      source: options.source,
      contextKey: request.contextKey,
      actor: input.actor ?? options.actorFor(request),
      workspace: input.workspace ?? options.workspace,
      threadId: input.threadId ?? null,
      ...input,
    });
  };
}

export function createChannelAuditRecorder<Request extends ChannelBridgeRequestBase>(options: {
  channelId: "discord" | "slack";
  auditLog: { append(input: Omit<AuditEvent, "id" | "timestamp">): AuditEvent };
  actorFor(request: Request): WebActivityActor;
  actorIdFor(request: Request): string;
}): (request: Request, input: ChannelAuditInput) => void {
  return (request, input) => {
    options.auditLog.append({
      channelId: options.channelId,
      contextKey: input.contextKey ?? request.contextKey,
      actor: input.actor ?? options.actorFor(request),
      actorId: request.authUser?.user.id ?? options.actorIdFor(request),
      actorRole: request.authUser?.groups.map((group) => group.name).join(", ") ?? "unauthenticated",
      ...input,
    });
  };
}

export function createChannelPermissionChecker<Request extends ChannelBridgeRequestBase>(
  userStore: UserStore,
): (request: Request, permission: Permission | null) => boolean {
  return (request, permission) => userStore.hasPermission(request.authUser, permission);
}
