import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildLifecycleStartInput,
  buildLifecycleStopInput,
  buildStartInput,
  buildStopInput,
  buildWatchdogInput,
  isAuthorized,
  parseAllowList,
  parseChatIds,
  replies,
} from "../src/domain/telegram-bot.ts";
import { authMiddleware } from "../src/bot/middleware/auth.ts";
import { telegramContact } from "../src/bot/middleware/contact.ts";
import {
  addressKeyboard,
  callbacks,
  confirmStartKeyboard,
  mainMenuKeyboard,
  networkKeyboard,
  packKeyboard,
  statusKeyboard,
  visitorMenuKeyboard,
} from "../src/bot/keyboards/main-menu.ts";
import { render } from "../src/bot/ui/render.ts";

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
  const gate = authMiddleware(async (telegramId) => [111, 222].includes(telegramId), {
    publicCommands: new Set(), publicCallbacks: new Set(), commands: new Map(), callbacks: new Map(),
  });

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
  assert.equal(callbackStranger.nextCalled, false, "callbacks pass through the same permission check");
});

test("public interactions reach visitors without making restricted callbacks public", async () => {
  const gate = authMiddleware(async (telegramId, permission) => telegramId === 111 && permission === "session.start", {
    publicCommands: new Set(["start", "status"]),
    publicCallbacks: new Set([callbacks.status, callbacks.requestAccess]),
    commands: new Map([["server_start", "session.start"]]),
    callbacks: new Map([[callbacks.confirmStart, "session.start"]]),
  });
  const visitorCommand = stubContext({ userId: 999, isCommand: true });
  visitorCommand.ctx = {
    ...visitorCommand.ctx,
    has: () => true,
    message: { text: "/status", entities: [{ type: "bot_command", offset: 0, length: 7 }] },
  } as never;
  await gate(visitorCommand.ctx as never, visitorCommand.next);
  assert.equal(visitorCommand.nextCalled, true);

  const visitorStatus = stubContext({ userId: 999, isCommand: false, isCallback: true });
  await gate(visitorStatus.ctx as never, visitorStatus.next);
  assert.equal(visitorStatus.nextCalled, true);

  const restricted = stubContext({ userId: 999, isCommand: false, isCallback: true });
  restricted.ctx.callbackQuery = { data: callbacks.confirmStart };
  await gate(restricted.ctx as never, restricted.next);
  assert.equal(restricted.nextCalled, false);
});

test("only private Telegram chats become access candidates", () => {
  const privateContact = telegramContact({
    chat: { id: 999, type: "private" },
    from: { id: 111, first_name: "Ada", last_name: "Lovelace", username: "ada" },
  } as never);
  assert.deepEqual(privateContact, {
    id: 111,
    chatId: 999,
    displayName: "Ada Lovelace",
    username: "ada",
  });
  assert.equal(telegramContact({ chat: { id: -1, type: "group" }, from: { id: 111 } } as never), null);
});

test("the allow-list is strict: ids parse, garbage throws, absence denies", () => {
  assert.deepEqual(parseAllowList("111, 222,333"), [111, 222, 333]);
  assert.deepEqual(parseAllowList(""), []);
  assert.throws(() => parseAllowList("111,not-an-id"));
  assert.equal(isAuthorized(111, [111, 222]), true);
  assert.equal(isAuthorized(999, [111, 222]), false);
  assert.equal(isAuthorized(111, []), false);
});

test("callback screens edit in place and unchanged refreshes are harmless", async () => {
  let edited = false;
  await render(
    {
      callbackQuery: { message: {} },
      editMessageText: async () => {
        edited = true;
      },
    } as never,
    "<b>Status</b>",
    undefined,
    "edit",
  );
  assert.equal(edited, true);

  await assert.doesNotReject(() =>
    render(
      {
        callbackQuery: { message: {} },
        editMessageText: async () => {
          throw new Error("Call to 'editMessageText' failed! (400: Bad Request: message is not modified)");
        },
      } as never,
      "same",
      undefined,
      "edit",
    ),
  );
});

test("the start input builder reproduces the committed example verbatim", async () => {
  const url = new URL("../../workflows/start-server.input.example.json", import.meta.url);
  const example = JSON.parse(await readFile(url, "utf8"));
  const built = buildStartInput({
    operationId: example.operationId,
    instanceId: example.instanceId,
    worldId: example.worldId,
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
    worldId: example.worldId,
    stopStateMachineArn: example.stopStateMachineArn,
  });
  assert.deepEqual(built, example);
});

test("the stop input builder reproduces the committed example verbatim", async () => {
  const url = new URL("../../workflows/stop-server.input.example.json", import.meta.url);
  const example = JSON.parse(await readFile(url, "utf8"));
  assert.deepEqual(
    buildStopInput({ operationId: example.operationId, instanceId: example.instanceId, worldId: example.worldId }),
    example,
  );
});

test("the Lifecycle V2 builders reproduce their committed examples verbatim", async () => {
  const startUrl = new URL("../../workflows/start-server-v2.input.example.json", import.meta.url);
  const start = JSON.parse(await readFile(startUrl, "utf8"));
  assert.deepEqual(buildLifecycleStartInput({
    serverId: start.serverId,
    operationId: start.operationId,
    sessionId: start.sessionId,
    instanceId: start.instanceId,
    worldId: start.worldId,
    connectionAddress: start.connectionAddress,
  }), start);

  const stopUrl = new URL("../../workflows/stop-server-v2.input.example.json", import.meta.url);
  const stop = JSON.parse(await readFile(stopUrl, "utf8"));
  assert.deepEqual(buildLifecycleStopInput({
    serverId: stop.serverId,
    operationId: stop.operationId,
    sessionId: stop.sessionId,
    instanceId: stop.instanceId,
    worldId: stop.worldId,
  }), stop);
});

test("a requester is attributed when present, and the examples stay the ownerless case", async () => {
  const url = new URL("../../workflows/start-server.input.example.json", import.meta.url);
  const example = JSON.parse(await readFile(url, "utf8"));
  const attributed = buildStartInput({
    operationId: example.operationId,
    instanceId: example.instanceId,
    worldId: example.worldId,
    connectionAddress: example.connectionAddress,
    requestedBy: "telegram:111",
  });
  assert.equal(attributed.requestedBy, "telegram:111");
  const { requestedBy: _dropped, ...rest } = attributed;
  assert.deepEqual(rest, example, "attribution must add a field, never change the contract");

  const watchdog = buildWatchdogInput({
    operationId: "op",
    instanceId: "i-0",
    worldId: "world",
    stopStateMachineArn: "arn:stop",
    requestedBy: "telegram:111",
  });
  assert.equal(watchdog.requestedBy, "telegram:111");
});

test("replies carry what the player actually needs", () => {
  assert.match(replies.welcome(), /Spawnpoint/);
  assert.doesNotMatch(replies.welcome(), /Starting the server/);
  assert.match(replies.unknown(), /\/help or \/start/);
  assert.match(replies.confirmStart(), /billed AWS session/);

  const menu = mainMenuKeyboard("https://example.com/");
  const menuCallbacks = menu.inline_keyboard
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
  assert.equal(
    menu.inline_keyboard.flat().some(
      (button) => "web_app" in button && button.web_app.url === "https://example.com/",
    ),
    true,
  );
  assert.deepEqual(
    visitorMenuKeyboard().inline_keyboard.flat().map((button) => "callback_data" in button ? button.callback_data : null),
    [callbacks.status, callbacks.requestAccess],
  );
  assert.equal(
    menu.inline_keyboard.flat().some(
      (button) => "url" in button && button.url === "https://example.com/" && button.text === "Open panel in browser",
    ),
    true,
  );
  const confirmationCallbacks = confirmStartKeyboard().inline_keyboard
    .flat()
    .filter((button) => "callback_data" in button)
    .map((button) => button.callback_data);
  assert.deepEqual(confirmationCallbacks, [callbacks.confirmStart, callbacks.menu]);

  const copiedNetworkValues = networkKeyboard("b6079f73c6698651").inline_keyboard
    .flat()
    .filter((button) => "copy_text" in button)
    .map((button) => button.copy_text.text);
  assert.deepEqual(copiedNetworkValues, [
    "b6079f73c6698651",
    "sudo zerotier-cli join b6079f73c6698651",
  ]);

  const copiedAddresses = addressKeyboard(
    "172.29.23.24:25565",
    "http://172.29.23.24:3000",
  ).inline_keyboard
    .flat()
    .filter((button) => "copy_text" in button)
    .map((button) => button.copy_text.text);
  assert.deepEqual(copiedAddresses, ["172.29.23.24:25565", "http://172.29.23.24:3000"]);

  const runningStatus = statusKeyboard("172.29.23.24:25565").inline_keyboard.flat();
  assert.equal(
    runningStatus.some((button) => "copy_text" in button),
    true,
    "running status offers a copy button",
  );
  assert.equal(
    statusKeyboard().inline_keyboard.flat().some((button) => "copy_text" in button),
    false,
    "stopped status does not advertise an unusable address",
  );

  const packButtons = packKeyboard("https://example/signed").inline_keyboard.flat();
  assert.equal(
    packButtons.some((button) => "url" in button && button.url === "https://example/signed"),
    true,
  );

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
  assert.match(status, /Active release: <code>1\.0<\/code>/);

  const stopped = replies.status({
    instanceState: "stopped",
    desiredRelease: null,
    activeRelease: null,
    connectionAddress: "172.29.23.24:25565",
  });
  assert.doesNotMatch(stopped, /172\.29\.23\.24/, "no address for a stopped server");

  const visitorStatus = replies.publicStatus("running");
  assert.match(visitorStatus, /RUNNING/);
  assert.doesNotMatch(visitorStatus, /172\.29|release|ZeroTier|Grafana/i);
  assert.match(replies.visitorWelcome(), /request access/i);
  assert.match(replies.accessRequested(), /owner can now review/i);

  assert.match(replies.pack("1.0"), /delete your mods folder entirely/i);
  assert.match(replies.packMissing("1.0"), /no published pack yet/);
});
