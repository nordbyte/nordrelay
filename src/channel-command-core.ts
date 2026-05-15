import { CHANNEL_COMMANDS } from "./channel-command-catalog.js";
import { normalizeChannelCommandName } from "./channel-runtime.js";

export type CommandTransport = "telegram" | "discord" | "slack";

export type SharedChannelCommandHandler<TRequest> = (
  request: TRequest,
  argument: string,
  command: string,
) => Promise<void> | void;

export interface SharedChannelCommandBinding<TRequest> {
  names: readonly string[];
  handler: SharedChannelCommandHandler<TRequest>;
}

export interface SharedChannelCommandDispatchResult {
  matched: boolean;
  command: string;
}

export interface SharedChannelCommandDispatcher<TRequest> {
  readonly transport: CommandTransport;
  readonly commandNames: string[];
  dispatch(request: TRequest, command: string, argument: string): Promise<SharedChannelCommandDispatchResult>;
}

export function createSharedChannelCommandDispatcher<TRequest>(input: {
  transport: CommandTransport;
  bindings: readonly SharedChannelCommandBinding<TRequest>[];
}): SharedChannelCommandDispatcher<TRequest> {
  const handlers = new Map<string, SharedChannelCommandHandler<TRequest>>();
  for (const binding of input.bindings) {
    for (const name of binding.names) {
      const normalized = normalizeChannelCommandName(name);
      if (!normalized) {
        throw new Error("Channel command name is required.");
      }
      if (handlers.has(normalized)) {
        throw new Error(`Duplicate ${input.transport} command binding: ${normalized}`);
      }
      handlers.set(normalized, binding.handler);
    }
  }

  return {
    transport: input.transport,
    commandNames: [...handlers.keys()].sort(),
    async dispatch(request, command, argument) {
      const normalized = normalizeChannelCommandName(command);
      const handler = handlers.get(normalized);
      if (!handler) {
        return { matched: false, command: normalized };
      }
      await handler(request, argument, normalized);
      return { matched: true, command: normalized };
    },
  };
}

export function channelCatalogCommandNames(transport: CommandTransport): string[] {
  return CHANNEL_COMMANDS
    .filter((entry) => {
      if (transport === "telegram") return entry.telegram !== false;
      if (transport === "discord") return entry.discord !== false;
      return entry.slack !== false;
    })
    .map((entry) => normalizeChannelCommandName(entry.name))
    .sort();
}

export function channelCommandCoverage(input: {
  transport: CommandTransport;
  implemented: Iterable<string>;
  aliases?: Record<string, readonly string[]>;
}): {
  advertised: string[];
  implemented: string[];
  missing: string[];
  extra: string[];
} {
  const advertised = new Set(channelCatalogCommandNames(input.transport));
  const implemented = new Set([...input.implemented].map(normalizeChannelCommandName));
  for (const [canonical, aliases] of Object.entries(input.aliases ?? {})) {
    if (!implemented.has(normalizeChannelCommandName(canonical))) continue;
    for (const alias of aliases) {
      implemented.add(normalizeChannelCommandName(alias));
    }
  }
  const aliasNames = new Set(Object.values(input.aliases ?? {}).flat().map(normalizeChannelCommandName));
  return {
    advertised: [...advertised].sort(),
    implemented: [...implemented].sort(),
    missing: [...advertised].filter((name) => !implemented.has(name)).sort(),
    extra: [...implemented].filter((name) => !advertised.has(name) && !aliasNames.has(name)).sort(),
  };
}
