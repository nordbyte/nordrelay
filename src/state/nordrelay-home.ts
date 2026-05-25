import os from "node:os";
import path from "node:path";

export function resolveNordRelayHome(): string {
  const configuredHome = process.env.NORDRELAY_HOME?.trim();
  const fallbackHome = path.join(os.homedir(), ".nordrelay");
  const home = configuredHome || fallbackHome;
  const resolvedHome = path.resolve(home);
  return isFilesystemRoot(resolvedHome) ? fallbackHome : resolvedHome;
}

function isFilesystemRoot(candidate: string): boolean {
  const parsed = path.parse(candidate);
  return parsed.root === candidate;
}
