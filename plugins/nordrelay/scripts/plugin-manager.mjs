import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const RUNTIME_ROOT = findRuntimeRoot();

export async function commandPlugin(options) {
  const flags = parsePluginFlags(options.rawFlags ?? []);
  if (flags.subcommand === "help") {
    printPluginHelp();
    return;
  }
  const service = await createPluginService(options.home);
  if (flags.subcommand === "list") {
    const plugins = await service.list();
    if (!plugins.length) {
      console.log("No plugins installed.");
      console.log("Install one with `nordrelay plugin install github:owner/repo` or create one with `nordrelay plugin create ./my-plugin --id my-plugin`.");
      return;
    }
    for (const plugin of plugins) {
      console.log(`${plugin.enabled ? "enabled " : "disabled"} ${plugin.id}@${plugin.version} ${plugin.name}`);
      if (plugin.description) console.log(`  ${plugin.description}`);
      if (plugin.permissions.length) console.log(`  permissions: ${plugin.permissions.join(", ")}`);
    }
    return;
  }
  if (flags.subcommand === "install") {
    const source = flags.args[0];
    if (!source) throw new Error("Usage: nordrelay plugin install <path|github:owner/repo|https://github.com/owner/repo>");
    const plugin = await service.install({
      source,
      ref: flags.ref,
      enable: flags.enable,
      approvePermissions: flags.approve,
      force: flags.force,
    });
    console.log(`Installed ${plugin.id}@${plugin.version}.`);
    console.log(plugin.enabled ? "Plugin is enabled." : "Plugin is installed but disabled.");
    return;
  }
  if (flags.subcommand === "create") {
    const targetDir = flags.args[0];
    if (!targetDir || !flags.id) throw new Error("Usage: nordrelay plugin create <dir> --id <plugin-id> [--name <name>]");
    const created = await service.scaffold({
      targetDir,
      id: flags.id,
      name: flags.name,
      description: flags.description,
    });
    console.log(`Created plugin scaffold: ${created}`);
    return;
  }
  if (flags.subcommand === "validate") {
    const source = flags.args[0];
    if (!source) throw new Error("Usage: nordrelay plugin validate <path>");
    const result = await service.validate(source);
    console.log(result.ok ? "Plugin manifest is valid." : "Plugin manifest is invalid.");
    for (const issue of result.issues) {
      console.log(`${issue.level.toUpperCase()}: ${issue.message}`);
    }
    return;
  }
  if (flags.subcommand === "enable" || flags.subcommand === "disable") {
    const id = requiredPluginId(flags);
    const plugin = flags.subcommand === "enable" ? await service.enable(id) : await service.disable(id);
    console.log(`${flags.subcommand === "enable" ? "Enabled" : "Disabled"} ${plugin.id}.`);
    return;
  }
  if (flags.subcommand === "remove") {
    const id = requiredPluginId(flags);
    await service.remove(id);
    console.log(`Removed ${id}.`);
    return;
  }
  if (flags.subcommand === "reload") {
    const id = requiredPluginId(flags);
    const plugin = await service.updateManifest(id);
    console.log(`Reloaded ${plugin.id}@${plugin.version}.`);
    return;
  }
  if (flags.subcommand === "check-update") {
    const id = requiredPluginId(flags);
    console.log(JSON.stringify(await service.checkUpdate(id), null, 2));
    return;
  }
  if (flags.subcommand === "update") {
    const id = requiredPluginId(flags);
    const plugin = await service.update(id);
    console.log(`Updated ${plugin.id}@${plugin.version}.`);
    return;
  }
  if (flags.subcommand === "rollback") {
    const id = requiredPluginId(flags);
    const plugin = await service.rollback(id, flags.version);
    console.log(`Rolled back ${plugin.id}@${plugin.version}.`);
    return;
  }
  if (flags.subcommand === "catalog") {
    const catalog = await service.catalog();
    console.log(JSON.stringify(catalog, null, 2));
    return;
  }
  if (flags.subcommand === "invoke") {
    const id = requiredPluginId(flags);
    const type = flags.args[1] || "workflow-action";
    const capabilityId = flags.args[2];
    if (!capabilityId) throw new Error("Usage: nordrelay plugin invoke <plugin-id> <workflow-action|command|web-panel|artifact-handler|diagnostics|collector> <id> [--input-json '{...}']");
    const input = parseInputJson(flags.inputJson);
    const result =
      type === "workflow-action" ? await service.invokeWorkflowAction(id, capabilityId, input) :
      type === "command" ? await service.invokeCommand(id, capabilityId, input) :
      type === "web-panel" ? await service.invokeWebPanel(id, capabilityId, input) :
      type === "artifact-handler" ? await service.invokeArtifactHandler(id, capabilityId, input) :
      type === "diagnostics" ? await service.invokeDiagnostics(id, input) :
      type === "collector" ? await service.invokeCollector(id, capabilityId, input) :
      null;
    if (!result) throw new Error(`Unknown plugin capability type: ${type}`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (flags.subcommand === "settings") {
    const id = requiredPluginId(flags);
    if (!flags.set.length) {
      const plugin = await service.get(id);
      if (!plugin) throw new Error(`Plugin not found: ${id}`);
      console.log(JSON.stringify(plugin.settingsSummary, null, 2));
      return;
    }
    const settings = Object.fromEntries(flags.set.map((pair) => splitSetting(pair)));
    const plugin = await service.updateSettings(id, settings);
    console.log(`Updated settings for ${plugin.id}.`);
    return;
  }
  if (flags.subcommand === "log") {
    const id = requiredPluginId(flags);
    const log = await service.readLog(id);
    console.log(log || "No plugin log entries.");
    return;
  }
  printPluginHelp();
}

function parsePluginFlags(rawFlags) {
  const copy = [...rawFlags];
  const subcommand = copy[0] && !copy[0].startsWith("-") ? copy.shift() : "list";
  const flags = {
    subcommand,
    args: [],
    ref: undefined,
    id: undefined,
    name: undefined,
    description: undefined,
    enable: false,
    approve: false,
    force: false,
    set: [],
    inputJson: "{}",
    version: undefined,
  };
  for (let index = 0; index < copy.length; index += 1) {
    const arg = copy[index];
    if (arg === "--ref") flags.ref = requireValue(copy, ++index, arg);
    else if (arg === "--id") flags.id = requireValue(copy, ++index, arg);
    else if (arg === "--name") flags.name = requireValue(copy, ++index, arg);
    else if (arg === "--description") flags.description = requireValue(copy, ++index, arg);
    else if (arg === "--input-json") flags.inputJson = requireValue(copy, ++index, arg);
    else if (arg === "--version") flags.version = requireValue(copy, ++index, arg);
    else if (arg === "--enable") flags.enable = true;
    else if (arg === "--approve") flags.approve = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--set") flags.set.push(requireValue(copy, ++index, arg));
    else if (arg === "--help" || arg === "-h") flags.subcommand = "help";
    else flags.args.push(arg);
  }
  return flags;
}

function requiredPluginId(flags) {
  const id = flags.args[0] || flags.id;
  if (!id) throw new Error(`Usage: nordrelay plugin ${flags.subcommand} <plugin-id>`);
  return id;
}

function splitSetting(pair) {
  const index = pair.indexOf("=");
  if (index <= 0) throw new Error("--set requires KEY=VALUE");
  return [pair.slice(0, index), pair.slice(index + 1)];
}

function parseInputJson(raw) {
  const parsed = JSON.parse(raw || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--input-json must be a JSON object");
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function createPluginService(home) {
  const modulePath = path.join(RUNTIME_ROOT, "dist", "plugins", "plugin-service.js");
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Missing plugin runtime. Run \`npm run build\` in ${RUNTIME_ROOT}.`);
  }
  const mod = await import(pathToFileURL(modulePath).href);
  return new mod.PluginService(home, { enabled: process.env.NORDRELAY_PLUGINS_ENABLED !== "false" });
}

function findRuntimeRoot() {
  const sourceRoot = process.env.NORDRELAY_SOURCE_ROOT;
  if (sourceRoot && fs.existsSync(path.join(sourceRoot, "package.json"))) {
    return path.resolve(sourceRoot);
  }
  const candidates = [
    path.resolve(PLUGIN_ROOT, "..", ".."),
    path.resolve(PLUGIN_ROOT, ".."),
    process.cwd(),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "package.json")) && fs.existsSync(path.join(candidate, "src"))) {
      return candidate;
    }
  }
  return path.resolve(PLUGIN_ROOT, "..", "..");
}

function printPluginHelp() {
  console.log("Usage: nordrelay plugin <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  list                         List installed plugins");
  console.log("  install <source>             Install from a local path or GitHub repository");
  console.log("  create <dir> --id <id>       Scaffold a new plugin");
  console.log("  validate <path>              Validate a plugin manifest");
  console.log("  enable <id>                  Enable a plugin and approve declared permissions");
  console.log("  disable <id>                 Disable a plugin");
  console.log("  remove <id>                  Remove a plugin");
  console.log("  reload <id>                  Reload manifest metadata from the installed plugin");
  console.log("  check-update <id>            Check whether the plugin source has changed");
  console.log("  update <id>                  Reinstall from the original source/ref");
  console.log("  rollback <id>                Switch back to an installed previous version");
  console.log("  settings <id> [--set K=V]    Show or update plugin settings");
  console.log("  catalog                      Print enabled extension points as JSON");
  console.log("  invoke <id> <type> <cap>     Invoke an executable plugin capability");
  console.log("  log <id>                     Show plugin log output");
  console.log("");
  console.log("Install options:");
  console.log("  --ref <ref>                  Git branch, tag, or commit for GitHub installs");
  console.log("  --enable                     Enable after install");
  console.log("  --approve                    Approve declared permissions after install");
  console.log("  --force                      Reinstall same version");
  console.log("  --input-json <json>          JSON object for plugin invoke");
  console.log("  --version <version>          Explicit plugin version for rollback");
}
