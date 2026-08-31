import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The access API's authority is layered by position: the handler authenticates,
// then resolves a granted identity, then crosses one access.manage gate, and a
// route inherits whatever it is written below. That reads well and is invisible
// — a new route pasted one line too high is authorised by nothing but a
// session, and no other test would notice. These tests pin the order and force
// every route to be classified.

async function loadHandlerSource(): Promise<string> {
  const url = new URL("../src/handlers/access-api.ts", import.meta.url);
  return readFile(url, "utf8");
}

function indexOfOrFail(source: string, needle: string): number {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, `expected the handler to contain: ${needle}`);
  return index;
}

// Routes that are deliberately reachable by any authenticated caller, with the
// reason each one is safe without a permission of its own.
const SELF_SCOPED_ROUTES = new Map<string, string>([
  ['path === "/auth/telegram"', "login itself: it is what produces a session"],
  ['path === "/session"', "reports the caller's own session"],
  ['path === "/access/request"', "how somebody with no access asks for it"],
  ['path === "/me"', "the caller's own identity and role"],
  ['path === "/me/subscriptions"', "the caller's own notification choices"],
]);

test("the access API's gates stay in escalating order", async () => {
  const source = await loadHandlerSource();

  const login = indexOfOrFail(source, 'path === "/auth/telegram"');
  const sessionGate = indexOfOrFail(source, "invalid_or_expired_session");
  const identityGate = indexOfOrFail(source, "access_not_granted");
  const manageGate = indexOfOrFail(source, 'requirePermission(identity, "access.manage")');

  assert.ok(login < sessionGate, "login must be answerable before a session exists");
  assert.ok(sessionGate < identityGate, "a caller must hold a session before an identity is resolved");
  assert.ok(identityGate < manageGate, "the access.manage gate must sit below the identity gate");

  // Everything the access.manage gate protects must be written below it.
  for (const managed of [
    'path === "/access/candidates"',
    'path === "/access/identities"',
    'path.endsWith("/approve")',
    'path.endsWith("/dismiss")',
    'path.endsWith("/role")',
  ]) {
    assert.ok(
      indexOfOrFail(source, managed) > manageGate,
      `${managed} is only authorised by being written below the access.manage gate`,
    );
  }
});

test("every route is either self-scoped, permission-checked, or behind the manage gate", async () => {
  const source = await loadHandlerSource();
  const manageGate = indexOfOrFail(source, 'requirePermission(identity, "access.manage")');

  // Handlers that check a permission themselves, so a route may call them from
  // anywhere below the identity gate. Each function's body runs to the start of
  // the next declaration, `async` ones included — getting that boundary wrong
  // made an earlier version of this test pass on an unguarded route.
  const declarations = [...source.matchAll(/^(?:export )?(?:async )?function (\w+)\(/gm)].map((match) => ({
    name: match[1],
    start: match.index ?? 0,
  }));
  const guardedHandlers = new Set(
    declarations
      .filter(({ start }, position) => {
        const end = declarations[position + 1]?.start ?? source.length;
        return source.slice(start, end).includes("requirePermission(");
      })
      .map(({ name }) => name),
  );

  const routeLines: Array<{ line: string; number: number; offset: number }> = [];
  let offset = 0;
  for (const [number, line] of source.split("\n").entries()) {
    if (/^\s*if \(method === "(GET|POST|PUT|DELETE)"/.test(line)) routeLines.push({ line, number, offset });
    offset += line.length + 1;
  }

  assert.ok(routeLines.length >= 15, "expected the handler to route more than a handful of paths");

  for (const { line, number, offset } of routeLines) {
    const selfScoped = [...SELF_SCOPED_ROUTES.keys()].some((route) => line.includes(route));
    if (selfScoped) continue;
    if (offset > manageGate) continue;

    const called = [...line.matchAll(/return (?:await )?(\w+)\(/g)].map((match) => match[1]);
    const inlineGuard = line.includes("requirePermission(");
    assert.ok(
      inlineGuard || called.some((name) => guardedHandlers.has(name)),
      `line ${number + 1} routes without any permission check, and sits above the access.manage gate: ` +
        `${line.trim()} — give its handler a requirePermission call, move it below the gate, ` +
        "or add it to SELF_SCOPED_ROUTES with the reason it needs none",
    );
  }
});
