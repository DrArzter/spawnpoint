import assert from "node:assert/strict";
import test from "node:test";

import { MAX_HOST_LOG_LINES, filterHostLog, redact, type RawLogEvent } from "../src/control-plane/host-log.ts";
import { createHostLogReader } from "../src/control-plane/aws-operation-progress.ts";
import { ResourceNotFoundException } from "@aws-sdk/client-cloudwatch-logs";

const T0 = Date.parse("2026-11-22T22:36:25Z");
const event = (message: string, offset = 0): RawLogEvent => ({ timestamp: T0 + offset * 1000, message });
const texts = (messages: readonly string[]) => filterHostLog(messages.map((message, index) => event(message, index))).map((line) => line.text);

test("the milestones of a real start read as human steps with their seconds", () => {
  const lines = filterHostLog([
    event("step=session_start at=2026-11-22T22:36:25Z elapsed_seconds=0\n"),
    event("step=world_prepared at=2026-11-22T22:36:39Z elapsed_seconds=14\n", 14),
    event("resumed_from=worlds/prominence/archives/2026-11-22T20-00-00Z.tar.zst\n", 15),
    event("step=release_downloaded at=2026-11-22T22:56:34Z elapsed_seconds=1209\n", 1209),
    event("seconds=1137\ndownloaded=1659\n", 1210),
    event("step=game_starting at=2026-11-22T22:56:40Z elapsed_seconds=1215\n", 1215),
    event(" Container spawnpoint-prominence-mc-1  Started\n", 1216),
  ]);
  assert.deepEqual(lines.map((line) => [line.kind, line.text]), [
    ["step", "Session started (0 s)"],
    ["step", "World prepared (14 s)"],
    ["step", "Release downloaded (1209 s)"],
    ["result", "Seconds: 1137"],
    ["result", "Downloaded: 1659"],
    ["step", "Game starting (1215 s)"],
    ["container", "Container spawnpoint-prominence-mc-1 Started"],
  ]);
  assert.equal(lines[1]?.at, "2026-11-22T22:36:39Z");
  assert.equal(lines[6]?.at, new Date(T0 + 1216_000).toISOString());
});

test("the release copy says how it ran: folders or files, why, and how much came down", () => {
  assert.deepEqual(texts(["fetch=folders", "fetch_reason=listed", "fetched_bytes=734003200", "discarded=0", "layout=legacy", "fetch=shards", "shards=212", "fetched=1659", "fetch_reason=mostly-cached"]), [
    "Copy: folders",
    "Copy reason: listed",
    "Bytes copied: 734003200",
    "Discarded: 0",
    "Layout: legacy",
    "Copy: shards",
    "Shards: 212",
    "Fetched: 1659",
    "Copy reason: mostly-cached",
  ]);
});

test("an unknown step name still reads in words, and a malformed step line is dropped", () => {
  assert.deepEqual(texts(["step=addons_resolved at=2026-11-22T22:36:25Z elapsed_seconds=3", "step=bad at=yesterday elapsed_seconds=3"]), ["Addons resolved (3 s)"]);
});

test("a Compose warning that quotes a piece of a key never passes, in any shape", () => {
  const dropped = [
    'time="2026-11-22T22:36:30Z" level=warning msg="The \\"2a\\" variable is not set. Defaulting to a blank string."',
    'WARN[0000] The "CF_API_KEY" variable is not set. Defaulting to a blank string.',
    'warning: The "a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ" variable is not set. Defaulting to a blank string.',
    'error: The "10" variable is not set. Defaulting to a blank string.',
    'The "x7Qw" variable is not set. Defaulting to a blank string.',
  ];
  assert.deepEqual(texts(dropped), []);
});

test("only known safe shapes pass", () => {
  assert.deepEqual(texts([
    "+ docker compose up -d",
    "downloading release 1.2.3",
    "owner=somebody",
    "CF_API_KEY=abc",
    "result=passed extra",
    "Container x Exploded",
    "mc-1  | [22:40:01] [Server thread/INFO]: Done (41.2s)! For help, type \"help\"",
    "step=session_start at=2026-11-22T22:36:25Z elapsed_seconds=0 extra=1",
    "",
  ]), []);
});

test("error and warning lines of the scripts pass; the game's pass only with an exception or a level", () => {
  assert.deepEqual(texts([
    "error: release manifest missing",
    "warning: backup older than a day",
    "mc-1  | [22:41:10] [Server thread/ERROR]: Could not load mod",
    "mc-1  | java.lang.IllegalStateException: no world",
    "mc-1  | [22:41:11] [Server thread/WARN]: Can't keep up!",
    "mc-1  | [22:41:12] [Server thread/INFO]: Preparing spawn area",
  ]), [
    "release manifest missing",
    "backup older than a day",
    "[22:41:10] [Server thread/ERROR]: Could not load mod",
    "java.lang.IllegalStateException: no world",
    "[22:41:11] [Server thread/WARN]: Can't keep up!",
  ]);
});

test("secrets inside a passing line are redacted", () => {
  const bcrypt = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
  const out = texts([
    `error: bad key ${bcrypt} given`,
    "error: CURSEFORGE_API_KEY=abcdef0123 rejected",
    'warning: token="two words" refused',
    "error: SESSION_PASSWORD: hunter2 rejected",
    "error: digest 3f786850e387550fdab836ed7e6dc881de23001b rejected",
    "error: blob aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgYmFzZTY0IHZhbHVl rejected",
    "mc-1  | [22:41:10] [Server thread/WARN]: /203.0.113.7:51234 lost connection",
  ]).join("\n");
  assert.ok(!out.includes("N9qo8u") && !out.includes("$2a$"));
  assert.ok(!out.includes("abcdef0123") && !out.includes("two words") && !out.includes("hunter2"));
  assert.ok(!out.includes("3f786850") && !out.includes("aGVsbG8"));
  assert.ok(!out.includes("203.0.113.7"));
  assert.match(out, /CURSEFORGE_API_KEY=\[redacted\] rejected/);
});

test("a secret name inside another value is still found, and a non-secret value is left as it is", () => {
  assert.equal(redact("url=https://example.test/a?api_key=abc123 next"), "url=https://example.test/a?api_key=[redacted] next");
  assert.equal(redact('{"Token": "abc", "mode": "fast"}'), '{"Token": [redacted], "mode": "fast"}');
  assert.equal(redact("level=info password: hunter2"), "level=info password: [redacted]");
});

test("Compose container lines pass with or without the tick and the duration", () => {
  assert.deepEqual(texts(["✔ Container game-mc-1  Started  0.4s", "Container game-mc-1 Stopping", " ✔ Container game.mc_1 Created 12s"]), [
    "Container game-mc-1 Started",
    "Container game-mc-1 Stopping",
    "Container game.mc_1 Created",
  ]);
});

test("a container name with many hyphens is not mistaken for a secret", () => {
  assert.deepEqual(texts([" Container spawnpoint-minecraft-rostik-12345678-mc-1 Starting"]), ["Container spawnpoint-minecraft-rostik-12345678-mc-1 Starting"]);
  assert.equal(redact("worlds/minecraft-rostik-12345678"), "worlds/minecraft-rostik-12345678");
});

test("escapes and carriage returns are removed, lines are bounded, and only the newest forty stay", () => {
  assert.deepEqual(texts(["\u001b[1m\u001b[32m Container x Started\u001b[0m\r\nerror: " + "x ".repeat(150)]).map((text) => text.length <= 200), [true, true]);
  const many = Array.from({ length: 100 }, (_, index) => `step=n${index} at=2026-11-22T22:36:25Z elapsed_seconds=${index}`);
  const lines = texts(many);
  assert.equal(lines.length, MAX_HOST_LOG_LINES);
  assert.equal(lines.at(-1), "N99 (99 s)");
});

test("events of two streams merge by time", () => {
  const lines = filterHostLog([event("error: second", 5), event("error: first", 1), event("error: third", 9)]);
  assert.deepEqual(lines.map((line) => line.text), ["first", "second", "third"]);
});

// --- the reader --------------------------------------------------------------

const INSTANCE = "i-0123456789abcdef0";
const COMMAND = "11111111-2222-3333-4444-555555555555";
const host = { instanceId: INSTANCE, startedAt: new Date("2026-11-22T22:36:00Z"), endedAt: null };

function readerWith(options: Readonly<{ commands: ReadonlyArray<Record<string, unknown>>; streams: Record<string, RawLogEvent[]> }>) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const ssm = { async send(command: { constructor: { name: string }; input: Record<string, unknown> }) { calls.push({ name: command.constructor.name, input: command.input }); return { Commands: options.commands }; } };
  const logs = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      calls.push({ name: command.constructor.name, input: command.input });
      const events = options.streams[String(command.input.logStreamName)];
      if (events === undefined) throw new ResourceNotFoundException({ message: "no stream", $metadata: {} });
      return { events };
    },
  };
  return { reader: createHostLogReader({ ssm: ssm as never, logs: logs as never }), calls };
}

test("the reader finds the newest shell command in the window and reads both streams of the one log group", async () => {
  const { reader, calls } = readerWith({
    commands: [
      { CommandId: "99999999-2222-3333-4444-555555555555", DocumentName: "AWS-RunShellScript", RequestedDateTime: new Date("2026-11-22T22:30:00Z") },
      { CommandId: COMMAND, DocumentName: "AWS-RunShellScript", RequestedDateTime: new Date("2026-11-22T22:36:20Z") },
      { CommandId: "88888888-2222-3333-4444-555555555555", DocumentName: "AWS-ApplyAnsiblePlaybooks", RequestedDateTime: new Date("2026-11-22T22:36:40Z") },
    ],
    streams: {
      [`${COMMAND}/${INSTANCE}/aws-runShellScript/stderr`]: [event("step=session_start at=2026-11-22T22:36:25Z elapsed_seconds=0")],
      [`${COMMAND}/${INSTANCE}/aws-runShellScript/stdout`]: [event("mc-1  | java.lang.RuntimeException: boom", 3)],
    },
  });
  const lines = await reader(host);
  assert.deepEqual(lines.map((line) => line.text), ["Session started (0 s)", "java.lang.RuntimeException: boom"]);
  const reads = calls.filter((call) => call.name === "GetLogEventsCommand");
  assert.equal(reads.length, 2);
  assert.ok(reads.every((call) => call.input.logGroupName === "/spawnpoint/session-commands" && call.input.startFromHead === false && Number(call.input.limit) <= 200));
  await reader(host);
  assert.equal(calls.filter((call) => call.name === "ListCommandsCommand").length, 1);
});

test("the reader returns nothing before the command exists or its stream is written", async () => {
  assert.deepEqual(await readerWith({ commands: [], streams: {} }).reader(host), []);
  const { reader } = readerWith({ commands: [{ CommandId: COMMAND, DocumentName: "AWS-RunShellScript", RequestedDateTime: new Date("2026-11-22T22:36:20Z") }], streams: {} });
  assert.deepEqual(await reader(host), []);
});

test("the reader reads a host step document's own stream, and ignores the watchdog's probe", async () => {
  const { reader, calls } = readerWith({
    commands: [
      { CommandId: COMMAND, DocumentName: "spawnpoint-start-session", RequestedDateTime: new Date("2026-11-22T22:36:20Z") },
      { CommandId: "77777777-2222-3333-4444-555555555555", DocumentName: "spawnpoint-session-activity", RequestedDateTime: new Date("2026-11-22T22:36:50Z") },
    ],
    streams: { [`${COMMAND}/${INSTANCE}/startSession/stderr`]: [event("step=session_start at=2026-11-22T22:36:25Z elapsed_seconds=0")] },
  });
  assert.deepEqual((await reader(host)).map((line) => line.text), ["Session started (0 s)"]);
  assert.ok(calls.filter((call) => call.name === "GetLogEventsCommand").every((call) => String(call.input.logStreamName).includes("/startSession/")));
});

test("the reader ignores a command sent after the host start ended", async () => {
  const { reader } = readerWith({ commands: [{ CommandId: COMMAND, DocumentName: "AWS-RunShellScript", RequestedDateTime: new Date("2026-11-22T23:30:00Z") }], streams: {} });
  assert.deepEqual(await reader({ ...host, endedAt: new Date("2026-11-22T22:50:00Z") }), []);
});
