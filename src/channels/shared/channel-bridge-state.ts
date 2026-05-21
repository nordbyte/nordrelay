export interface ChannelBusyState {
  processing: boolean;
  switching: boolean;
  transcribing?: boolean;
  approving?: boolean;
}

export type ChannelBusyReason<TExternal extends object> =
  | { busy: false; kind: "idle" }
  | { busy: true; kind: "connector"; state: ChannelBusyState }
  | ({ busy: true; kind: "external" } & TExternal);

export interface ChannelPickState<Kind extends string = string> {
  kind: Kind;
  values: string[];
}

export interface ChannelExternalMirrorState<MessageId extends string | number = string> {
  threadId: string;
  rolloutPath: string;
  lastLine: number;
  lastTypingAt?: number;
  workingNoticeTurnKey?: string | null;
  statusMessageId?: MessageId;
  turnId?: string | null;
  startedAt?: Date | null;
  latestStatus?: string;
  latestStatusAt?: number;
  latestAgentLine?: number;
  latestMirroredEventLine?: number;
  approvalRequestIds?: string[];
  artifactsDeliveredForTurnId?: string | null;
  artifactsDeliveryInFlightForTurnId?: string | null;
  activityStartedTurnKey?: string;
  activityFinishedTurnKey?: string;
  activityToolStartLines?: number[];
  activityToolEndLines?: number[];
}

export interface ChannelQueueStatusState<MessageId extends string | number = string> {
  messageId?: MessageId;
  lastText?: string;
}
