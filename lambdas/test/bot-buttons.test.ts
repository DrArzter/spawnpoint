import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { Update } from "grammy/types";

// Buttons are callback queries, and a callback query that nobody answers is a
// button that spins and then does nothing. These tests press the real
// keyboards' buttons through the real bot — middleware, permissions, handler,
// rendering — with only the Telegram API intercepted, so a button that stopped
// working shows up here as a missing answer or a failure reply.

process.env.AWS_REGION ??= "eu-central-1";
process.env.ACCESS_TABLE_NAME ??= "spawnpoint-access-test";
process.env.MINI_APP_URL ??= "https://example.invalid/panel";
process.env.CONNECTION_HOST ??= "172.29.23.24";
process.env.WORLD_ID ??= "world";
process.env.PANEL_ADDRESS ??= "http://172.29.23.24:3000";
process.env.ZEROTIER_NETWORK_ID ??= "b6079f73c6698651";

const { buildBot } = await import("../src/bot/bot.ts");
const { callbacks } = await import("../src/bot/keyboards/main-menu.ts");
type Permission = Parameters<Parameters<typeof buildBot>[1]["hasPermission"]>[1];

type ApiCall = { method: string; payload: Record<string, unknown> };

function pressable(grants: ReadonlySet<Permission>) {
  const calls: ApiCall[] = [];
  const bot = buildBot("123:TEST", {
    observe: async () => undefined,
    request: async () => undefined,
    hasPermission: async (_id, permission) => grants.has(permission),
  });
  bot.botInfo = {
    id: 123, is_bot: true, first_name: "Spawnpoint", username: "spawnpoint_bot",
    can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false,
  } as typeof bot.botInfo;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: true } as never;
  });
  const press = async (data: string, userId = 111): Promise<ApiCall[]> => {
    calls.length = 0;
    await bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "q1",
        from: { id: userId, is_bot: false, first_name: "Player" },
        chat_instance: "c",
        data,
        message: { message_id: 7, date: 0, chat: { id: userId, type: "private", first_name: "Player" }, text: "menu" },
      },
    } as unknown as Update);
    return [...calls];
  };
  return { press };
}

const everything = new Set<Permission>(["status.read", "connection.read", "release.read", "session.start"]);

test("an authorised player's navigation buttons answer the query and replace the card", async () => {
  const { press } = pressable(everything);
  for (const data of [callbacks.menu, callbacks.address, callbacks.network, callbacks.requestStart]) {
    const calls = await press(data);
    assert.equal(calls[0]?.method, "answerCallbackQuery", `${data}: the query is answered first`);
    const edit = calls.find((call) => call.method === "editMessageText");
    assert.ok(edit, `${data}: the card is edited in place, got ${calls.map((call) => call.method).join(",")}`);
    assert.equal(edit.payload.parse_mode, "HTML");
    assert.ok(!calls.some((call) => call.method === "sendMessage"), `${data}: no failure reply and no new message`);
  }
});

test("a visitor's request-access button works without any permission", async () => {
  const { press } = pressable(new Set());
  const calls = await press(callbacks.requestAccess);
  assert.equal(calls[0]?.method, "answerCallbackQuery");
  assert.ok(calls.some((call) => call.method === "editMessageText"));
});

test("a button the player may not use is refused with an alert, not silence", async () => {
  const { press } = pressable(new Set<Permission>(["status.read"]));
  const calls = await press(callbacks.address);
  assert.equal(calls.length, 1, "one answer and nothing else");
  assert.equal(calls[0]?.method, "answerCallbackQuery");
  assert.equal(calls[0]?.payload.show_alert, true);
});

test("every button a keyboard can emit has a handler", async () => {
  const source = await readFile(new URL("../src/bot/bot.ts", import.meta.url), "utf8");
  for (const key of Object.keys(callbacks)) {
    assert.match(source, new RegExp(`bot\\.callbackQuery\\(callbacks\\.${key}\\b`), `no handler answers callbacks.${key}`);
  }
});
