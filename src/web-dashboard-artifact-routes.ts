import type { IncomingMessage, ServerResponse } from "node:http";

import type { RelayRuntime } from "./relay-runtime.js";
import type { AuthenticatedUser } from "./user-management.js";
import {
  readJsonBody,
  requiredSearch,
  sendFile,
  sendJson,
  stringField,
} from "./web-dashboard-http.js";

export interface DashboardArtifactRouteOptions {
  runtime: RelayRuntime;
  authUser: AuthenticatedUser;
  assertCurrentSessionScope: (authUser: AuthenticatedUser) => Promise<void>;
}

export async function handleDashboardArtifactRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: DashboardArtifactRouteOptions,
): Promise<boolean> {
  const { runtime, authUser } = options;

  if (req.method === "GET" && url.pathname === "/api/artifacts") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, { reports: await runtime.artifacts() });
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/artifacts") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, { removed: await runtime.deleteArtifact(requiredSearch(url, "turnId")) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/artifacts/bulk") {
    const body = await readJsonBody(req);
    await options.assertCurrentSessionScope(authUser);
    const action = stringField(body, "action");
    const turnIds = Array.isArray(body.turnIds) ? body.turnIds.filter((item): item is string => typeof item === "string") : [];
    if (action !== "delete") {
      throw new Error("Unsupported artifact bulk action.");
    }
    const removed = [];
    for (const turnId of turnIds) {
      if (await runtime.deleteArtifact(turnId)) {
        removed.push(turnId);
      }
    }
    sendJson(res, 200, { removed });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/artifacts/zip") {
    await options.assertCurrentSessionScope(authUser);
    const bundle = await runtime.createArtifactZip(requiredSearch(url, "turnId"));
    if (!bundle) {
      sendJson(res, 404, { error: "Artifact turn not found or ZIP could not be created" });
      return true;
    }
    sendFile(res, bundle.path, bundle.name);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/artifacts/file") {
    await options.assertCurrentSessionScope(authUser);
    const turnId = requiredSearch(url, "turnId");
    const relativePath = requiredSearch(url, "path");
    const report = await runtime.artifact(turnId);
    const artifact = report?.artifacts.find((candidate) => candidate.relativePath === relativePath);
    if (!artifact) {
      sendJson(res, 404, { error: "Artifact not found" });
      return true;
    }
    sendFile(res, artifact.localPath, artifact.name);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/artifacts/preview") {
    await options.assertCurrentSessionScope(authUser);
    const preview = await runtime.artifactPreview(requiredSearch(url, "turnId"), requiredSearch(url, "path"));
    if (!preview) {
      sendJson(res, 404, { error: "Artifact not found" });
      return true;
    }
    sendJson(res, 200, preview);
    return true;
  }

  return false;
}
