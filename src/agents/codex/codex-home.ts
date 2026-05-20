import os from "node:os";
import path from "node:path";

export function resolveCodexDir(): string | null {
  const codexHome = cleanEnvPath(process.env.CODEX_HOME);
  if (codexHome) {
    return codexHome;
  }

  const home = resolveUserHomeDir();
  return home ? path.join(home, ".codex") : null;
}

function resolveUserHomeDir(): string | null {
  const home = cleanEnvPath(process.env.HOME);
  if (home) {
    return home;
  }

  const userProfile = cleanEnvPath(process.env.USERPROFILE);
  if (userProfile) {
    return userProfile;
  }

  const homeDrive = cleanEnvPath(process.env.HOMEDRIVE);
  const homePath = cleanEnvPath(process.env.HOMEPATH);
  if (homeDrive && homePath) {
    return path.join(homeDrive, homePath);
  }

  const osHome = cleanEnvPath(os.homedir());
  return osHome || null;
}

function cleanEnvPath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
