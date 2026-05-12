import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type PiRpcEvent = Record<string, unknown>;
export type PiRpcEventHandler = (event: PiRpcEvent) => void;

export interface PiRpcClientOptions {
  commandPath: string;
  cwd: string;
  sessionDir?: string;
  sessionPath?: string;
  model?: string;
  thinking?: string;
  env?: NodeJS.ProcessEnv;
}

export interface PiRpcResponse<TData = unknown> {
  type: "response";
  command?: string;
  success: boolean;
  data?: TData;
  error?: string;
  id?: string;
}

type PendingRequest = {
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export class PiRpcClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly handlers = new Set<PiRpcEventHandler>();
  private stderrBuffer = "";

  constructor(private options: PiRpcClientOptions) {}

  updateOptions(options: Partial<PiRpcClientOptions>): void {
    this.options = { ...this.options, ...options };
  }

  onEvent(handler: PiRpcEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async send<TData = unknown>(
    command: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<PiRpcResponse<TData>> {
    this.ensureStarted();
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      throw new Error("Pi RPC process is not available");
    }

    const id = typeof command.id === "string" ? command.id : `nr-${randomUUID()}`;
    const payload = { ...command, id };

    const response = await new Promise<PiRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC command timed out: ${String(command.type ?? "unknown")}`));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, { resolve, reject, timeout });

      child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(id);
          pending.reject(error);
        }
      });
    });

    if (!response.success) {
      throw new Error(response.error || `Pi RPC command failed: ${String(command.type ?? "unknown")}`);
    }
    return response as PiRpcResponse<TData>;
  }

  ensureStarted(): void {
    if (this.child && !this.child.killed) {
      return;
    }

    const args = ["--mode", "rpc"];
    if (this.options.sessionDir) {
      args.push("--session-dir", this.options.sessionDir);
    }
    if (this.options.sessionPath) {
      args.push("--session", this.options.sessionPath);
    }
    if (this.options.model) {
      args.push("--model", this.options.model);
    }
    if (this.options.thinking) {
      args.push("--thinking", this.options.thinking);
    }

    const child = spawn(this.options.commandPath, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stderrBuffer = "";

    attachJsonlReader(child.stdout, (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrBuffer = appendWithLimit(this.stderrBuffer, typeof chunk === "string" ? chunk : chunk.toString("utf8"), 20_000);
    });
    child.on("error", (error) => {
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
    });
    child.on("exit", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      const stderr = this.stderrBuffer.trim();
      this.rejectAll(new Error(`Pi RPC process exited (${reason})${stderr ? `: ${stderr}` : ""}`));
      this.child = null;
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.rejectAll(new Error("Pi RPC process stopped"));
    child?.kill("SIGTERM");
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: PiRpcEvent;
    try {
      message = JSON.parse(line) as PiRpcEvent;
    } catch {
      return;
    }

    if (message.type === "response" && typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(message.id);
        pending.resolve(message as unknown as PiRpcResponse);
        return;
      }
    }

    for (const handler of this.handlers) {
      handler(message);
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      onLine(line);
    }
  });

  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    }
  });
}

function appendWithLimit(current: string, addition: string, limit: number): string {
  const next = `${current}${addition}`;
  return next.length <= limit ? next : next.slice(next.length - limit);
}
