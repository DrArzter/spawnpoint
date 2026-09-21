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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
  worldId: string;
  requestedBy?: string;
}>) {
  return {
    operationId: args.operationId,
    instanceId: args.instanceId,
    // Required, never defaulted: the machines pass it to the host, and a
    // default world would be a silent choice of which world somebody started.
    // No address: the host's session summary answers with it and the machine
    // carries it back — a public address does not exist before the start.
    worldId: args.worldId,
    ...(args.requestedBy === undefined ? {} : { requestedBy: args.requestedBy }),
    timing: POLL_TIMING,
  };
}

export function buildWatchdogInput(args: Readonly<{
  operationId: string;
  instanceId: string;
  worldId: string;
  stopStateMachineArn: string;
  requestedBy?: string;
}>) {
  return {
    operationId: args.operationId,
    instanceId: args.instanceId,
    worldId: args.worldId,
    stopStateMachineArn: args.stopStateMachineArn,
    ...(args.requestedBy === undefined ? {} : { requestedBy: args.requestedBy }),
    timing: WATCHDOG_TIMING,
    stopTiming: POLL_TIMING,
  };
}

export function buildStopInput(args: Readonly<{
  operationId: string;
  instanceId: string;
  worldId: string;
  requestedBy?: string;
}>) {
  return {
    operationId: args.operationId,
    instanceId: args.instanceId,
    worldId: args.worldId,
    ...(args.requestedBy === undefined ? {} : { requestedBy: args.requestedBy }),
    timing: POLL_TIMING,
  };
}

export type PlacementMode = "single" | "shared";
export type LaunchMode = "disabled" | "enabled";

export function buildLifecycleStartInput(args: Readonly<{
  serverId: string;
  operationId: string;
  sessionId: string;
  instanceId: string;
  worldId: string;
  requestedBy?: string;
  // ADR-0054: `single` starts the configured instance as before; `shared`
  // places the session on a registered host with room. The configured
  // instance is always registered first, so it is always a candidate.
  placement?: PlacementMode;
  // Whether a session nothing has room for may launch a host from the fleet
  // template, and which commit of this repository that host checks out.
  launch?: LaunchMode;
  appCommit?: string;
}>) {
  return {
    serverId: args.serverId,
    operationId: args.operationId,
    sessionId: args.sessionId,
    leaseTtlSeconds: 1800,
    watchdogRegistrationLeaseTtlSeconds: 60,
    watchdogStopLeaseTtlSeconds: 1800,
    instanceId: args.instanceId,
    worldId: args.worldId,
    placement: args.placement ?? "single",
    launch: args.launch ?? "disabled",
    appCommit: args.appCommit ?? "main",
    ...(args.requestedBy === undefined ? {} : { requestedBy: args.requestedBy }),
    startTiming: POLL_TIMING,
    stopTiming: POLL_TIMING,
    watchdogTiming: WATCHDOG_TIMING,
  };
}

export function buildLifecycleStopInput(args: Readonly<{
  serverId: string;
  operationId: string;
  sessionId: string;
  instanceId: string;
  worldId: string;
  requestedBy?: string;
}>) {
  return {
    serverId: args.serverId,
    operationId: args.operationId,
    sessionId: args.sessionId,
    leaseTtlSeconds: 1800,
    instanceId: args.instanceId,
    worldId: args.worldId,
    ...(args.requestedBy === undefined ? {} : { requestedBy: args.requestedBy }),
    stopTiming: POLL_TIMING,
  };
}

export const replies = {
  denied: (): string => "You are not on this server's list. Ask the owner to add your Telegram id.",

  welcome: (): string =>
    [
      "<b>Spawnpoint</b>",
      "Game server control panel",
      "",
      "Choose an action below.",
      "Opening this menu does not start the AWS host.",
    ].join("\n"),

  visitorWelcome: (): string =>
    [
      "<b>Spawnpoint</b>",
      "Game server control panel",
      "",
      "You can see whether a game host is online or request access from an owner.",
      "Server addresses, private-network details and paid actions stay hidden until approval.",
    ].join("\n"),

  publicStatus: (instanceState: string): string =>
    [
      "<b>Server status</b>",
      "",
      `State: <code>${escapeHtml(instanceState.toUpperCase())}</code>`,
      "Games: Minecraft, Factorio, Project Zomboid",
      "",
      "Request access to receive connection details and game controls.",
    ].join("\n"),

  accessRequested: (): string =>
    "<b>Access requested</b>\n\nAn owner can now review your Telegram account in Spawnpoint. Sending the request again is harmless.",

  requestAccessInPrivate: (): string =>
    "Open a private chat with this bot and send /start before requesting access.",

  confirmStart: (): string =>
    [
      "<b>Start server</b>",
      "",
      "Booting the modpack takes a few minutes and begins a billed AWS session.",
      "Nothing happens until you press the confirmation button.",
    ].join("\n"),

  network: (networkId: string): string => {
    const safeNetworkId = escapeHtml(networkId);
    return [
      "<b>ZeroTier</b>",
      "",
      `Network ID: <code>${safeNetworkId}</code>`,
      `Linux: <code>sudo zerotier-cli join ${safeNetworkId}</code>`,
      "Windows/macOS: ZeroTier → Join New Network → paste the ID.",
      "",
      "After joining, ask the owner to authorize your device.",
    ].join("\n");
  },

  // A null address is a strategy with no standing answer: a public world's
  // address is issued per session and read from /status while it runs.
  address: (args: Readonly<{ connectionAddress: string | null; panelAddress: string }>): string => [
    "<b>Addresses</b>",
    "",
    args.connectionAddress === null
      ? "Minecraft: issued per session — the public address changes with every start; /status shows the current one while the server runs."
      : `Minecraft: <code>${escapeHtml(args.connectionAddress)}</code>`,
    `Grafana: <code>${escapeHtml(args.panelAddress)}</code>`,
    "",
    args.connectionAddress === null
      ? "Grafana is reachable only through ZeroTier; both only while the AWS host is running."
      : "Both are reachable only through ZeroTier and only while the AWS host is running.",
  ].join("\n"),

  starting: (operationId: string): string =>
    [
      "<b>Server is starting</b>",
      "",
      "Allow a few minutes for the mods to load. I will post here when it is ready.",
      `Operation: <code>${escapeHtml(operationId)}</code>`,
    ].join("\n"),

  alreadyRunning: (): string =>
    "<b>Start already in progress</b>\n\nI am following the existing operation.",

  status: (args: Readonly<{
    instanceState: string;
    desiredRelease: string | null;
    activeRelease: string | null;
    connectionAddress: string | null;
  }>): string => {
    const lines = [
      "<b>Server status</b>",
      "",
      `State: <code>${escapeHtml(args.instanceState.toUpperCase())}</code>`,
    ];
    if (args.instanceState === "running") {
      lines.push(
        args.connectionAddress === null
          ? "Address: not published yet — refresh in a moment"
          : `Address: <code>${escapeHtml(args.connectionAddress)}</code>`,
      );
    }
    lines.push(
      "",
      `Active release: <code>${escapeHtml(args.activeRelease ?? "none yet")}</code>`,
      `Desired release: <code>${escapeHtml(args.desiredRelease ?? "none")}</code>`,
    );
    return lines.join("\n");
  },

  pack: (release: string): string =>
    [
      "<b>Client pack</b>",
      "",
      `Release: <code>${escapeHtml(release)}</code>`,
      "The download button lives for one hour; open this screen again for a fresh link.",
      "",
      "<b>Install:</b> delete your mods folder entirely, then unzip the pack in its place.",
    ].join("\n"),

  packMissing: (release: string): string =>
    `<b>Client pack unavailable</b>\n\nRelease <code>${escapeHtml(release)}</code> has no published pack yet.`,

  unknown: (): string => "<b>Unknown command</b>\n\nUse /help or /start to open the menu.",

  failure: (): string => "Something went wrong on my side. The owner can read the logs.",
} as const;
