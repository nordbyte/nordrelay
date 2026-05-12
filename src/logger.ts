import { redactUnknown } from "./redaction.js";

export type ConnectorLogFormat = "text" | "json";

export function installConsoleLogger(format: ConnectorLogFormat): void {
  if (format !== "json") {
    return;
  }

  const targetLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    targetLog(JSON.stringify(toLogRecord("info", args)));
  };
  console.warn = (...args: unknown[]) => {
    targetLog(JSON.stringify(toLogRecord("warn", args)));
  };
  console.error = (...args: unknown[]) => {
    targetLog(JSON.stringify(toLogRecord("error", args)));
  };
}

function toLogRecord(level: "info" | "warn" | "error", args: unknown[]): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    level,
    event: "console",
    message: args.map(formatArg).join(" "),
  };
}

function formatArg(value: unknown): string {
  return redactUnknown(value);
}
