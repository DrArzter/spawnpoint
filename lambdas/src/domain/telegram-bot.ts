// The Telegram bot's decisions, kept pure: authorising a user, building the
// exact workflow inputs, and wording the replies. grammY owns parsing and
// routing; the handler is transport; everything the bot *decides* lives here,
// under tests.
//
// The input builders are the single source of the canonical timings. The
// workflows/*.input.example.json files must equal their output — a test
// enforces it — so the bot, the owner scripts and the examples cannot drift
// apart silently.

// Fail closed by failing loudly: a malformed allow-list is a misconfiguration,
// and silently denying everybody would read as a mystery, not a fault.
export function parseAllowList(raw: string): readonly number[] {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return entries.map((entry) => {
    if (!/^[0-9]+$/.test(entry)) {
      throw new Error(`allow-list entry is not a numeric Telegram user id: ${entry}`);
    }
    return Number(entry);
  });
}

export function isAuthorized(userId: number, allowList: readonly number[]): boolean {
  return allowList.includes(userId);
}

// Notification targets: a comma-separated list of chat ids. Groups are
// negative, direct messages positive — both are legitimate targets, chosen by
// the owner in one parameter. Same strictness as the allow-list: garbage is a
// misconfiguration and throws.
export function parseChatIds(raw: string): readonly number[] {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) {
    throw new Error("no notification chat ids configured");
  }
  return entries.map((entry) => {
    if (!/^-?[0-9]+$/.test(entry)) {
      throw new Error(`chat id is not a number: ${entry}`);
    }
    return Number(entry);
  });
}

// One timing vocabulary for every machine input, matching the committed
// input examples verbatim.
const POLL_TIMING = {
  instancePollSeconds: 10,
  ssmPollSeconds: 10,
  commandPollSeconds: 15,
  maxInstancePolls: 30,
  maxSsmPolls: 30,
  maxCommandPolls: 60,
} as const;

const WATCHDOG_TIMING = {
  checkIntervalSeconds: 300,
  emptyChecksRequired: 3,
  maxTotalChecks: 96,
  maxConsecutiveProbeFailures: 6,
  maxStopRefusals: 3,
  probePollSeconds: 10,
  maxProbePolls: 30,
} as const;

// requestedBy attributes the operation to whoever asked ("every start has a
// requester attached", ADR-0006/0016). It rides into the execution input, so
// the history is the audit record today and the notifications leg reads it
// tomorrow. A stable, PII-minimal identity — "telegram:<id>" — never a name.
// Omitted entirely when absent, so the committed input examples remain the
// exact ownerless case.
export function buildStartInput(args: Readonly<{
  operationId: string;
  instanceId: string;
  connectionAddress: string;
  requestedBy?: string;
}>) {
  return {
    operationId: args.operationId,
    instanceId: args.instanceId,
    connectionAddress: args.connectionAddress,
    ...(args.requestedBy === undefined ? {} : { requestedBy: args.requestedBy }),
    timing: POLL_TIMING,
  };
}

export function buildWatchdogInput(args: Readonly<{
  operationId: string;
  instanceId: string;
  stopStateMachineArn: string;
  requestedBy?: string;
}>) {
  return {
    operationId: args.operationId,
    instanceId: args.instanceId,
    stopStateMachineArn: args.stopStateMachineArn,
    ...(args.requestedBy === undefined ? {} : { requestedBy: args.requestedBy }),
    timing: WATCHDOG_TIMING,
    stopTiming: POLL_TIMING,
  };
}

export const replies = {
  denied: (): string => "You are not on this server's list. Ask the owner to add your Telegram id.",

  welcome: (): string =>
    [
      "Spawnpoint controls the shared game server.",
      "",
      "/status — show server and release state",
      "/server_start — start a game session",
      "/pack — download the current client mod pack",
    ].join("\n"),

  confirmStart: (): string =>
    "Start the game server now? Booting the modpack takes a few minutes and begins a billed game session.",

  starting: (operationId: string): string =>
    `Starting the server — a few minutes for the mods to load. I will post here when it is ready. (${operationId})`,

  alreadyRunning: (): string => "A start is already in flight; joining it rather than starting another.",

  status: (args: Readonly<{
    instanceState: string;
    desiredRelease: string | null;
    activeRelease: string | null;
    connectionAddress: string;
  }>): string => {
    const lines = [`Server: ${args.instanceState}`];
    if (args.instanceState === "running") lines.push(`Address: ${args.connectionAddress}`);
    lines.push(`Release: active ${args.activeRelease ?? "none yet"}, desired ${args.desiredRelease ?? "none"}`);
    return lines.join("\n");
  },

  pack: (release: string, url: string): string =>
    [
      `Pack for release ${release}. The link lives for one hour; ask again for a fresh one.`,
      "",
      "Install: delete your mods folder ENTIRELY, then unzip this in its place.",
      url,
    ].join("\n"),

  packMissing: (release: string): string =>
    `Release ${release} has no published pack yet. Ask the owner to publish one.`,

  unknown: (): string => "Commands: /start — menu, /status — server state, /server_start — start a session, /pack — current mod pack.",

  failure: (): string => "Something went wrong on my side. The owner can read the logs.",
} as const;
