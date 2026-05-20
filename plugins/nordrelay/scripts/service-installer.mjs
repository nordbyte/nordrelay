import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_SCRIPT_PATH = fileURLToPath(new URL("./nordrelay.mjs", import.meta.url));

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseServiceFlags(argv) {
  const copy = [...argv];
  const subcommand = copy[0] && !copy[0].startsWith("-") ? copy.shift() : "status";
  const flags = {
    subcommand,
    start: true,
    name: process.platform === "win32" ? "NordRelay" : "nordrelay",
    label: "io.nordbyte.nordrelay",
    dryRun: false,
    platform: process.platform,
  };
  for (let i = 0; i < copy.length; i += 1) {
    const arg = copy[i];
    if (arg === "--no-start") flags.start = false;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--platform") flags.platform = requireValue(copy, ++i, arg);
    else if (arg === "--name") flags.name = requireValue(copy, ++i, arg);
    else if (arg === "--label") flags.label = requireValue(copy, ++i, arg);
  }
  validateServiceFlags(flags);
  return flags;
}

function validateServiceFlags(flags) {
  if (!["linux", "darwin", "win32"].includes(flags.platform)) {
    throw new Error(`Unsupported service platform: ${flags.platform}`);
  }
  assertSafeServiceIdentifier(flags.name, "--name");
  assertSafeServiceIdentifier(flags.label, "--label");
}

function assertSafeServiceIdentifier(value, flag) {
  const text = String(value ?? "");
  if (
    !text ||
    text.length > 128 ||
    text.includes("/") ||
    text.includes("\\") ||
    text.includes("..") ||
    path.basename(text) !== text ||
    !/^[A-Za-z0-9_. -]+$/.test(text)
  ) {
    throw new Error(`${flag} must be a simple service identifier without path components.`);
  }
}

function serviceRunArgs(options) {
  const args = ["service-run", "--home", options.home];
  if (options.host) args.push("--host", options.host);
  if (options.port) args.push("--port", String(options.port));
  return args;
}

function buildSystemdUserServiceSpec(options, flags) {
  const scriptPath = options.scriptPath || DEFAULT_SCRIPT_PATH;
  const unitPath = path.join(os.homedir(), ".config", "systemd", "user", `${flags.name}.service`);
  const execStart = [process.execPath, scriptPath, ...serviceRunArgs(options)].map(systemdQuote).join(" ");
  const content = [
    "[Unit]",
    "Description=NordRelay connector and WebUI",
    "After=network-online.target",
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
  ].join("\n");
  const action = flags.start ? "enable --now" : "enable";
  return {
    platform: "linux",
    path: unitPath,
    content,
    commands: [
      { command: "systemctl", args: ["--user", "daemon-reload"], label: "Reload systemd user units" },
      { command: "systemctl", args: ["--user", "enable", flags.start ? "--now" : "", `${flags.name}.service`].filter(Boolean), label: `systemctl --user ${action} ${flags.name}.service` },
    ],
  };
}

function buildLaunchdServiceSpec(options, flags) {
  const scriptPath = options.scriptPath || DEFAULT_SCRIPT_PATH;
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${flags.label}.plist`);
  const domain = launchdDomain();
  const commands = [
    { command: "launchctl", args: ["bootout", domain, plistPath], label: `Unload existing ${flags.label}`, settings: { allowFailure: true } },
  ];
  if (flags.start) {
    commands.push(
      { command: "launchctl", args: ["bootstrap", domain, plistPath], label: `Load ${flags.label}` },
      { command: "launchctl", args: ["enable", `${domain}/${flags.label}`], label: `Enable ${flags.label}`, settings: { allowFailure: true } },
      { command: "launchctl", args: ["kickstart", "-k", `${domain}/${flags.label}`], label: `Start ${flags.label}`, settings: { allowFailure: true } },
    );
  }
  return {
    platform: "darwin",
    path: plistPath,
    content: launchdPlist(flags.label, process.execPath, [scriptPath, ...serviceRunArgs(options)], options.home),
    commands,
  };
}

function buildWindowsTaskServiceSpec(options, flags) {
  const scriptPath = options.scriptPath || DEFAULT_SCRIPT_PATH;
  const taskCommand = windowsTaskCommand(process.execPath, [scriptPath, ...serviceRunArgs(options)]);
  const commands = [
    { command: "schtasks", args: ["/Create", "/F", "/SC", "ONLOGON", "/TN", flags.name, "/TR", taskCommand], label: `Create Windows task ${flags.name}` },
  ];
  if (flags.start) {
    commands.push({ command: "schtasks", args: ["/Run", "/TN", flags.name], label: `Start Windows task ${flags.name}`, settings: { allowFailure: true } });
  }
  return {
    platform: "win32",
    path: flags.name,
    content: "",
    commands,
  };
}

function serviceInstallSpec(options, flags) {
  if (flags.platform === "darwin") return buildLaunchdServiceSpec(options, flags);
  if (flags.platform === "win32") return buildWindowsTaskServiceSpec(options, flags);
  return buildSystemdUserServiceSpec(options, flags);
}

function systemdQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function launchdDomain() {
  return `gui/${process.getuid?.() ?? ""}`;
}

function launchdPlist(label, command, args, home) {
  const programArguments = [command, ...args]
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");
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
    `  <string>${xmlEscape(path.join(home, "service.log"))}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(path.join(home, "service.log"))}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function windowsTaskCommand(command, args) {
  return [command, ...args].map((part) => `"${String(part).replace(/"/g, '""')}"`).join(" ");
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export {
  buildLaunchdServiceSpec,
  buildSystemdUserServiceSpec,
  buildWindowsTaskServiceSpec,
  parseServiceFlags,
  serviceInstallSpec,
};
