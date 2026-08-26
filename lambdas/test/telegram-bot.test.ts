import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildStartInput,
  buildWatchdogInput,
  isAuthorized,
  parseAllowList,
  parseChatIds,
  replies,
} from "../src/domain/telegram-bot.ts";
import { authMiddleware } from "../src/bot/middleware/auth.ts";
import { callbacks, confirmStartKeyboard, mainMenuKeyboard } from "../src/bot/keyboards/main-menu.ts";

type StubContext = {
  replies: string[];
  nextCalled: boolean;
  ctx: {
    from?: { id: number };
    has: (filter: string) => boolean;
    reply: (text: string) => Promise<void>;
    callbackQuery?: { data: string };
    answerCallbackQuery: (options?: unknown) => Promise<void>;
  };
  next: () => Promise<void>;
};

function stubContext(args: { userId?: number; isCommand: boolean; isCallback?: boolean }): StubContext {
  const from = args.userId === undefined ? {} : { from: { id: args.userId } };
  const state: StubContext = {
    replies: [],
    nextCalled: false,
    ctx: {
      ...from,
      has: () => args.isCommand,
      ...(args.isCallback ? { callbackQuery: { data: callbacks.status } } : {}),
      reply: async (text: string) => {
        state.replies.push(text);
      },
      answerCallbackQuery: async () => undefined,
    },
    next: async () => {
      state.nextCalled = true;
    },
  };
  return state;
}

test("notification targets accept groups and DMs, and refuse to be silently empty", () => {
  assert.deepEqual(parseChatIds("-1001234, 555"), [-1001234, 555]);
  assert.throws(() => parseChatIds(""), /no notification chat ids/);
  assert.throws(() => parseChatIds("-100,abc"), /not a number/);
});

test("the auth middleware gates commands only, and denies politely", async () => {
  const gate = authMiddleware(async () => "111,222");

  const member = stubContext({ userId: 111, isCommand: true });
  await gate(member.ctx as never, member.next);
  assert.equal(member.nextCalled, true);

  const stranger = stubContext({ userId: 999, isCommand: true });
  await gate(stranger.ctx as never, stranger.next);
  assert.equal(stranger.nextCalled, false);
  assert.match(stranger.replies[0]!, /not on this server's list/);

  const chatter = stubContext({ userId: 999, isCommand: false });
  await gate(chatter.ctx as never, chatter.next);
  assert.equal(chatter.nextCalled, true, "ordinary chatter passes through ungated");
  assert.equal(chatter.replies.length, 0, "and is never answered with a denial");

  const faceless = stubContext({ isCommand: true });
  await gate(faceless.ctx as never, faceless.next);
  assert.equal(faceless.nextCalled, false, "a command without a sender goes nowhere");

  const callbackStranger = stubContext({ userId: 999, isCommand: false, isCallback: true });
  await gate(callbackStranger.ctx as never, callbackStranger.next);
  assert.equal(callbackStranger.nextCalled, false, "callbacks pass through the same allow-list");
});

test("the allow-list is strict: ids parse, garbage throws, absence denies", () => {
  assert.deepEqual(parseAllowList("111, 222,333"), [111, 222, 333]);
  assert.deepEqual(parseAllowList(""), []);
  assert.throws(() => parseAllowList("111,not-an-id"));
  assert.equal(isAuthorized(111, [111, 222]), true);
  assert.equal(isAuthorized(999, [111, 222]), false);
  assert.equal(isAuthorized(111, []), false);
});

test("the start input builder reproduces the committed example verbatim", async () => {
  const url = new URL("../../workflows/start-server.input.example.json", import.meta.url);
  const example = JSON.parse(await readFile(url, "utf8"));
  const built = buildStartInput({
    operationId: example.operationId,
    instanceId: example.instanceId,
    connectionAddress: example.connectionAddress,
  });
  assert.deepEqual(built, example);
});

test("the watchdog input builder reproduces the committed example verbatim", async () => {
  const url = new URL("../../workflows/idle-watchdog.input.example.json", import.meta.url);
  const example = JSON.parse(await readFile(url, "utf8"));
  const built = buildWatchdogInput({
    operationId: example.operationId,
    instanceId: example.instanceId,
    stopStateMachineArn: example.stopStateMachineArn,
  });
  assert.deepEqual(built, example);
});

test("a requester is attributed when present, and the examples stay the ownerless case", async () => {
  const url = new URL("../../workflows/start-server.input.example.json", import.meta.url);
  const example = JSON.parse(await readFile(url, "utf8"));
  const attributed = buildStartInput({
    operationId: example.operationId,
    instanceId: example.instanceId,
    connectionAddress: example.connectionAddress,
    requestedBy: "telegram:111",
  });
  assert.equal(attributed.requestedBy, "telegram:111");
  const { requestedBy: _dropped, ...rest } = attributed;
  assert.deepEqual(rest, example, "attribution must add a field, never change the contract");

  const watchdog = buildWatchdogInput({
    operationId: "op",
    instanceId: "i-0",
    stopStateMachineArn: "arn:stop",
    requestedBy: "telegram:111",
  });
  assert.equal(watchdog.requestedBy, "telegram:111");
});

test("replies carry what the player actually needs", () => {
  assert.match(replies.welcome(), /\/server_start/);
  assert.doesNotMatch(replies.welcome(), /Starting the server/);
  assert.match(replies.unknown(), /\/help or \/start/);
  assert.match(replies.confirmStart(), /billed game session/);

  const menuCallbacks = mainMenuKeyboard().inline_keyboard
    .flat()
    .filter((button) => "callback_data" in button)
    .map((button) => button.callback_data);
  assert.deepEqual(menuCallbacks, [
    callbacks.status,
    callbacks.address,
    callbacks.network,
    callbacks.pack,
    callbacks.requestStart,
  ]);
  const confirmationCallbacks = confirmStartKeyboard().inline_keyboard
    .flat()
    .filter((button) => "callback_data" in button)
    .map((button) => button.callback_data);
  assert.deepEqual(confirmationCallbacks, [callbacks.confirmStart, callbacks.menu]);

  assert.match(replies.network("b6079f73c6698651"), /sudo zerotier-cli join b6079f73c6698651/);
  assert.match(
    replies.address({
      connectionAddress: "172.29.23.24:25565",
      panelAddress: "http://172.29.23.24:3000",
    }),
    /Minecraft: <code>172\.29\.23\.24:25565<\/code>/,
  );

  const status = replies.status({
    instanceState: "running",
    desiredRelease: "1.1",
    activeRelease: "1.0",
    connectionAddress: "172.29.23.24:25565",
  });
  assert.match(status, /172\.29\.23\.24:25565/);
  assert.match(status, /active 1\.0/);

  const stopped = replies.status({
    instanceState: "stopped",
    desiredRelease: null,
    activeRelease: null,
    connectionAddress: "172.29.23.24:25565",
  });
  assert.doesNotMatch(stopped, /172\.29\.23\.24/, "no address for a stopped server");

  assert.match(replies.pack("1.0", "https://example/signed"), /delete your mods folder ENTIRELY/i);
  assert.match(replies.packMissing("1.0"), /no published pack yet/);
});
