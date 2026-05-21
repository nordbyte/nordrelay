import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export type AutostartTarget = "connector" | "webui";
export type AutostartAction = "install" | "uninstall";

export interface AutostartCommand {
  command: string;
  args: string[];
  label: string;
  allowFailure?: boolean;
}

export interface AutostartSpec {
  action: AutostartAction;
  target: AutostartTarget;
  platform: NodeJS.Platform;
  path: string;
  content: string;
  commands: AutostartCommand[];
}

export interface AutostartOptions {
  home: string;
  platform?: NodeJS.Platform;
  runtimeRoot?: string;
  nodePath?: string;
  userHome?: string;
}

export interface AutostartSettingError {
  key: string;
  message: string;
}

const AUTOSTART_SETTINGS: Record<string, AutostartTarget> = {
  NORDRELAY_AUTOSTART_ENABLED: "connector",
  NORDRELAY_WEBUI_AUTOSTART_ENABLED: "webui",
};

const TARGETS: Record<AutostartTarget, {
  description: string;
  linuxName: string;
  launchdLabel: string;
  windowsName: string;
  command: string;
  logFile: string;
}> = {
  connector: {
    description: "NordRelay connector",
    linuxName: "nordrelay",
    launchdLabel: "io.nordbyte.nordrelay",
    windowsName: "NordRelay",
    command: "foreground",
    logFile: "service.log",
  },
  webui: {
    description: "NordRelay WebUI",
    linuxName: "nordrelay-webui",
    launchdLabel: "io.nordbyte.nordrelay.webui",
    windowsName: "NordRelay WebUI",
    command: "web-run",
    logFile: "web-service.log",
  },
};

export async function applyAutostartSettings(
  patch: Record<string, string | null | undefined>,
  changedKeys: string[],
  options: AutostartOptions,
): Promise<AutostartSettingError[]> {
  const changed = new Set(changedKeys);
  const errors: AutostartSettingError[] = [];
  for (const [key, target] of Object.entries(AUTOSTART_SETTINGS)) {
    if (!changed.has(key)) {
      continue;
    }
    const enabled = autostartEnabledValue(patch[key]);
    try {
      await applyAutostart(target, enabled ? "install" : "uninstall", options);
    } catch (error) {
      errors.push({ key, message: friendlyAutostartError(error) });
    }
  }
  return errors;
}

export async function applyAutostart(
  target: AutostartTarget,
  action: AutostartAction,
  options: AutostartOptions,
): Promise<void> {
  const spec = buildAutostartSpec(target, action, options);
  if (action === "install" && spec.content) {
    await mkdir(path.dirname(spec.path), { recursive: true });
    await writeFile(spec.path, spec.content, { mode: 0o644 });
  }
  for (const command of spec.commands) {
    runAutostartCommand(command);
  }
  if (action === "uninstall" && spec.path && spec.platform !== "win32") {
    await rm(spec.path, { force: true });
  }
  if (action === "uninstall" && spec.platform === "linux") {
    runAutostartCommand({ command: "systemctl", args: ["--user", "daemon-reload"], label: "Reload systemd user units" });
  }
}

export function buildAutostartSpec(
  target: AutostartTarget,
  action: AutostartAction,
  options: AutostartOptions,
): AutostartSpec {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return buildLaunchdAutostartSpec(target, action, options);
  }
  if (platform === "win32") {
    return buildWindowsAutostartSpec(target, action, options);
  }
  return buildSystemdAutostartSpec(target, action, options);
}

function buildSystemdAutostartSpec(
  target: AutostartTarget,
  action: AutostartAction,
  options: AutostartOptions,
): AutostartSpec {
  const descriptor = TARGETS[target];
  const unitPath = path.posix.join(userHome(options), ".config", "systemd", "user", `${descriptor.linuxName}.service`);
  if (action === "uninstall") {
    return {
      action,
      target,
      platform: "linux",
      path: unitPath,
      content: "",
      commands: [
        {
          command: "systemctl",
          args: ["--user", "disable", "--now", `${descriptor.linuxName}.service`],
          label: `Disable ${descriptor.linuxName}.service`,
          allowFailure: true,
        },
      ],
    };
  }
  const execStart = commandParts(target, options).map(systemdQuote).join(" ");
  const content = [
    "[Unit]",
    `Description=${descriptor.description}`,
    "After=network-online.target",
    target === "webui" ? "After=nordrelay.service" : "",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execStart}`,
    "Restart=on-failure",
    "RestartSec=5",
    `Environment=NORDRELAY_HOME=${systemdQuote(options.home)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].filter((line, index, lines) => line || lines[index - 1] !== "").join("\n");
  return {
    action,
    target,
    platform: "linux",
    path: unitPath,
    content,
    commands: [
      { command: "systemctl", args: ["--user", "daemon-reload"], label: "Reload systemd user units" },
      { command: "systemctl", args: ["--user", "enable", "--now", `${descriptor.linuxName}.service`], label: `Enable ${descriptor.linuxName}.service` },
    ],
  };
}

function buildLaunchdAutostartSpec(
  target: AutostartTarget,
  action: AutostartAction,
  options: AutostartOptions,
): AutostartSpec {
  const descriptor = TARGETS[target];
  const plistPath = path.posix.join(userHome(options), "Library", "LaunchAgents", `${descriptor.launchdLabel}.plist`);
  const domain = launchdDomain();
  if (action === "uninstall") {
    return {
      action,
      target,
      platform: "darwin",
      path: plistPath,
      content: "",
      commands: [
        {
          command: "launchctl",
          args: ["bootout", domain, plistPath],
          label: `Unload ${descriptor.launchdLabel}`,
          allowFailure: true,
        },
      ],
    };
  }
  return {
    action,
    target,
    platform: "darwin",
    path: plistPath,
    content: launchdPlist(descriptor.launchdLabel, commandParts(target, options), options.home, descriptor.logFile),
    commands: [
      {
        command: "launchctl",
        args: ["bootout", domain, plistPath],
        label: `Unload existing ${descriptor.launchdLabel}`,
        allowFailure: true,
      },
      { command: "launchctl", args: ["bootstrap", domain, plistPath], label: `Load ${descriptor.launchdLabel}` },
      {
        command: "launchctl",
        args: ["enable", `${domain}/${descriptor.launchdLabel}`],
        label: `Enable ${descriptor.launchdLabel}`,
        allowFailure: true,
      },
      {
        command: "launchctl",
        args: ["kickstart", "-k", `${domain}/${descriptor.launchdLabel}`],
        label: `Start ${descriptor.launchdLabel}`,
        allowFailure: true,
      },
    ],
  };
}

function buildWindowsAutostartSpec(
  target: AutostartTarget,
  action: AutostartAction,
  options: AutostartOptions,
): AutostartSpec {
  const descriptor = TARGETS[target];
  if (action === "uninstall") {
    return {
      action,
      target,
      platform: "win32",
      path: descriptor.windowsName,
      content: "",
      commands: [
        {
          command: "schtasks",
          args: ["/Delete", "/F", "/TN", descriptor.windowsName],
          label: `Delete Windows task ${descriptor.windowsName}`,
          allowFailure: true,
        },
      ],
    };
  }
  return {
    action,
    target,
    platform: "win32",
    path: descriptor.windowsName,
    content: "",
    commands: [
      {
        command: "schtasks",
        args: ["/Create", "/F", "/SC", "ONLOGON", "/TN", descriptor.windowsName, "/TR", windowsTaskCommand(commandParts(target, options))],
        label: `Create Windows task ${descriptor.windowsName}`,
      },
      {
        command: "schtasks",
        args: ["/Run", "/TN", descriptor.windowsName],
        label: `Start Windows task ${descriptor.windowsName}`,
        allowFailure: true,
      },
    ],
  };
}

function commandParts(target: AutostartTarget, options: AutostartOptions): string[] {
  const descriptor = TARGETS[target];
  return [
    options.nodePath ?? process.execPath,
    nordrelayScriptPath(options),
    descriptor.command,
    "--home",
    options.home,
  ];
}

function nordrelayScriptPath(options: AutostartOptions): string {
  const root = options.runtimeRoot ?? process.env.NORDRELAY_SOURCE_ROOT ?? process.cwd();
  if ((options.platform ?? process.platform) === "win32") {
    return path.win32.join(root, "plugins", "nordrelay", "scripts", "nordrelay.mjs");
  }
  return path.posix.join(root, "plugins", "nordrelay", "scripts", "nordrelay.mjs");
}

function userHome(options: AutostartOptions): string {
  return options.userHome ?? os.homedir();
}

function runAutostartCommand(command: AutostartCommand): void {
  const result = spawnSync(command.command, command.args, {
    cwd: process.env.NORDRELAY_SOURCE_ROOT ?? process.cwd(),
    env: process.env,
    stdio: "pipe",
    windowsHide: true,
    encoding: "utf8",
  });
  if ((result.error || result.status !== 0) && !command.allowFailure) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const detail = output ? `: ${output}` : "";
    throw new Error(`${command.label} failed${detail}`);
  }
}

function autostartEnabledValue(value: string | null | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["true", "1", "yes", "on"].includes(normalized);
}

function friendlyAutostartError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function systemdQuote(value: string): string {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? ""}`;
}

function launchdPlist(label: string, commandPartsValue: string[], home: string, logFile: string): string {
  const programArguments = commandPartsValue
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  const logPath = path.posix.join(home, logFile);
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    programArguments,
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>NORDRELAY_HOME</key>",
    `    <string>${xmlEscape(home)}</string>`,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(logPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function windowsTaskCommand(parts: string[]): string {
  return parts.map((part) => `"${String(part).replace(/"/g, '""')}"`).join(" ");
}

function xmlEscape(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
