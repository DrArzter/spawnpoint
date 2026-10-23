// A release identity survives failed build attempts. Only publishing its manifest
// makes it immutable; retrying unpublished work keeps its source and version.
export type BuildSource = Readonly<{
  configCommit: string;
  configRepositoryUrl: string;
  configSourceKey: string;
  configSourceSha256: string;
}>;
export type BuildRequest = Readonly<{
  gameId: string;
  profileId: string;
  profileDigest: string;
  release: string;
  attempt: number;
  name: string;
  requestedBy: string;
  requestedAt: string;
  source: BuildSource;
}>;
export type BuildState = "starting" | "building" | "ready" | "failed";
export type BuildView = Readonly<{ release: string; attempt: number; state: BuildState; requestedAt: string; profileDigest: string }>;
export type StoredBuild = Readonly<{ request: BuildRequest; etag: string }>;
export interface ReleaseBuildPorts {
  read(): Promise<StoredBuild | null>;
  claim(request: BuildRequest, etag: string | null): Promise<boolean>;
  execution(name: string): Promise<"RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "ABORTED" | null>;
  published(request: BuildRequest): Promise<boolean>;
  start(request: BuildRequest): Promise<void>;
}

export async function observeBuild(request: BuildRequest, ports: ReleaseBuildPorts): Promise<BuildView> {
  // A workflow may fail after uploading its commit marker (e.g. catalog update).
  // Never turn that into permission to overwrite an already published release.
  const [published, execution] = await Promise.all([ports.published(request), ports.execution(request.name)]);
  const state = execution === "RUNNING" ? execution : published ? "ready" : execution;
  return {
    release: request.release, attempt: request.attempt, requestedAt: request.requestedAt, profileDigest: request.profileDigest,
    state: state === "ready" ? "ready" : state === null ? "starting" : state === "RUNNING" ? "building" : "failed",
  };
}

export async function requestReleaseBuild(
  input: Readonly<{ gameId: string; profileId: string; profileDigest: string; source: BuildSource; requestedBy: string; now: Date; nonce: string; retryRelease?: string }>,
  ports: ReleaseBuildPorts,
): Promise<BuildRequest> {
  const previous = await ports.read();
  if (input.retryRelease !== undefined && (previous?.request.release !== input.retryRelease || previous.request.profileDigest !== input.profileDigest)) throw new Error("build_changed");
  let request: BuildRequest;
  if (previous !== null && previous.request.profileDigest === input.profileDigest) {
    const view = await observeBuild(previous.request, ports);
    if (input.retryRelease !== undefined && view.state === "ready") throw new Error("build_changed");
    if (view.state === "building") return previous.request;
    if (view.state === "starting") {
      // Recover a claim whose caller died before StartExecution. Reusing the
      // persisted name AND input is idempotent, including a lost HTTP response.
      await ports.start(previous.request);
      return previous.request;
    }
    request = view.state === "failed"
      ? { ...previous.request, attempt: previous.request.attempt + 1, name: `panel-build-${input.nonce}`, requestedBy: input.requestedBy, requestedAt: input.now.toISOString() }
      : freshRequest(input);
  } else {
    // A changed preset cannot replace an in-flight attempt, even if that
    // attempt belongs to the preceding source revision.
    if (previous !== null) {
      const view = await observeBuild(previous.request, ports);
      if (view.state === "starting" || view.state === "building") throw new Error("build_in_progress");
    }
    request = freshRequest(input);
  }
  if (!await ports.claim(request, previous?.etag ?? null)) throw new Error("build_in_progress");
  await ports.start(request);
  return request;
}

function freshRequest(input: Readonly<{ gameId: string; profileId: string; profileDigest: string; source: BuildSource; requestedBy: string; now: Date; nonce: string }>): BuildRequest {
  // Epoch milliseconds plus a UUID-derived numeric suffix: accepted by the
  // existing release grammar, independent of GitHub run IDs, no user input.
  return {
    gameId: input.gameId, profileId: input.profileId, profileDigest: input.profileDigest,
    release: `${input.now.getTime()}.${Number.parseInt(input.nonce.slice(0, 8), 16)}`,
    attempt: 1, name: `panel-build-${input.nonce}`, requestedBy: input.requestedBy,
    requestedAt: input.now.toISOString(), source: input.source,
  };
}
