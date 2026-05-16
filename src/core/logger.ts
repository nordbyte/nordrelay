import { redactUnknown } from "./redaction.js";

export type ConnectorLogFormat = "text" | "json";

export function installConsoleLogger(format: ConnectorLogFormat): void {
  const targetLog = console.log.bind(console);
  const targetWarn = console.warn.bind(console);
  const targetError = console.error.bind(console);

  if (format !== "json") {
    console.log = (...args: unknown[]) => {
      targetLog(toTextRecord("info", args));
    };
    console.warn = (...args: unknown[]) => {
      targetWarn(toTextRecord("warn", args));
    };
    console.error = (...args: unknown[]) => {
      targetError(toTextRecord("error", args));
    };
    return;
  }

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

function toTextRecord(level: "info" | "warn" | "error", args: unknown[]): string {
  return `[${formatLocalTimestamp(new Date())}] ${level.toUpperCase()} ${args.map(formatArg).join(" ")}`;
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

function formatLocalTimestamp(date: Date): string {
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(" ");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
