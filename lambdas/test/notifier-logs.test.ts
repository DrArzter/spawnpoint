import assert from "node:assert/strict";
import test from "node:test";

process.env.AWS_REGION ??= "eu-central-1";

const { handler } = await import("../src/bot/notifier.ts");

async function logged(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    await run();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

const personal = { senderDisplayName: "Sample Person", telegramChatId: 424242, audience: "nobody" };

for (const [name, source, detailType] of [
  ["access approval", "spawnpoint.access", "Access Approved"],
  ["invitation", "spawnpoint.access", "Game Invitation"],
  ["execution event", "aws.states", "Step Functions Execution Status Change"],
] as const) {
  test(`an unparseable ${name} is logged by its shape, never its content`, async () => {
    const output = await logged(() => handler({ source, "detail-type": detailType, detail: personal }));
    assert.match(output, /unparseable/);
    assert.match(output, /senderDisplayName/, "the keys stay, so the log still explains the failure");
    assert.doesNotMatch(output, /Sample Person/);
    assert.doesNotMatch(output, /424242/);
  });
}
