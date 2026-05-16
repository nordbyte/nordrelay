import type {
  ActiveSessionsDto,
  QueueItemDto,
  RelaySnapshot,
  UnifiedJobsDto,
  WebTasksDto,
} from "./relay-runtime-types.js";
import type {
  WebActivityCategory,
  WebActivityEvent,
  WebActivitySource,
  WebActivityStatus,
  WebChatMessage,
} from "../web/web-state.js";

export interface RelayRuntimeActivityOptions {
  limit?: number;
  category?: WebActivityCategory;
  sinceMs?: number;
  source?: WebActivitySource;
  status?: WebActivityStatus;
}

export type RelayRuntimeDelegate = Record<string, any> & {
  snapshot(): Promise<RelaySnapshot>;
  chatHistory(limit?: number): Promise<WebChatMessage[]>;
  activeSessions(): Promise<ActiveSessionsDto>;
  activity(options?: RelayRuntimeActivityOptions): WebActivityEvent[];
  queue(): QueueItemDto[];
  tasks(): WebTasksDto;
  jobs(): Promise<UnifiedJobsDto>;
};
