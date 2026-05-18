import type { IncomingMessage, ServerResponse } from "node:http";

import type { RelayRuntime } from "../runtime/relay-runtime.js";
import type { AuthenticatedUser } from "../access/user-management.js";
import type { WebActivityActor } from "./web-state.js";
import { cursorPage, normalizeCursorLimit } from "../core/pagination.js";
import {
  numberParam,
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
  activityActor: WebActivityActor;
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
    const limit = normalizeCursorLimit(numberParam(url, "limit", 50), 50, 200);
    const search = (url.searchParams.get("search") || "").trim().toLowerCase();
    const kind = url.searchParams.get("kind") || "all";
    const reports = await runtime.artifacts(500);
    const filteredReports = reports.filter((report) => artifactReportMatches(report, kind, search));
    const page = cursorPage(filteredReports, url.searchParams.get("cursor") || undefined, limit, (report) => report.turnId);
    sendJson(res, 200, { reports: page.items, pagination: page.pagination });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/artifacts/usage") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.artifactUsage());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/artifacts/cleanup/preview") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.artifactCleanupPreview());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/artifacts/cleanup/run") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.artifactCleanupRun(options.activityActor));
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/artifacts") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, { removed: await runtime.deleteArtifact(requiredSearch(url, "turnId"), options.activityActor) });
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
      if (await runtime.deleteArtifact(turnId, options.activityActor)) {
        removed.push(turnId);
      }
    }
    sendJson(res, 200, { removed });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/artifacts/zip") {
    await options.assertCurrentSessionScope(authUser);
    const bundle = await runtime.createArtifactZip(requiredSearch(url, "turnId"), options.activityActor);
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
    const preview = await runtime.artifactPreview(turnId, relativePath);
    if (preview?.safeStatus === "blocked") {
      sendJson(res, 403, { error: "Artifact blocked by safe-file policy", warnings: preview.safeWarnings ?? [] });
      return true;
    }
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

  if (req.method === "GET" && url.pathname === "/api/artifacts/diff") {
    await options.assertCurrentSessionScope(authUser);
    const diff = await runtime.artifactDiff(requiredSearch(url, "turnId"), requiredSearch(url, "path"));
    if (!diff) {
      sendJson(res, 404, { error: "Artifact not found" });
      return true;
    }
    sendJson(res, 200, diff);
    return true;
  }

  return false;
}

function artifactReportMatches(report: Awaited<ReturnType<RelayRuntime["artifacts"]>>[number], kind: string, search: string): boolean {
  return (report.artifacts || []).some((artifact) => artifactFileMatches(artifact, kind, search));
}

function artifactFileMatches(artifact: { name?: string; relativePath?: string }, kind: string, search: string): boolean {
  const name = String(artifact.name || artifact.relativePath || "").toLowerCase();
  if (search && !name.includes(search)) {
    return false;
  }
  if (kind === "images") {
    return /\.(png|jpe?g|gif|webp|svg)$/i.test(name);
  }
  if (kind === "docs") {
    return !/\.(png|jpe?g|gif|webp|svg)$/i.test(name);
  }
  return true;
}
