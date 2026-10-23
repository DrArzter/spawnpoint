import assert from "node:assert/strict";
import test from "node:test";
import { type Identity } from "../src/access/domain.ts";
import { browserSessionCookieName, refreshCookieName } from "../src/access/login-session.ts";
import { createDispatcher } from "../src/handlers/api/dispatcher.ts";
import { capabilitiesForRoutes } from "../src/handlers/api/capabilities.ts";
import { type Caller, type Event, response } from "../src/handlers/api/http.ts";
import { composeRoutes, identityRoute, permissionRoute, publicRoute, sessionRoute } from "../src/handlers/api/routing.ts";

const principal: Caller = { provider: "telegram", subject: "123", displayName: "Test", username: null, email: null, photoUrl: null };
const viewer: Identity = { id: "viewer", displayName: "Test", roleId: "viewer", directGrants: [] };

function fixture(account: Caller | null = principal, identity: Identity | null = viewer) {
  const calls: string[] = [];
  let received: unknown;
  const routes = composeRoutes({
    "GET /public": publicRoute((event) => { calls.push("public"); received = event; return response(200, { public: true }); }),
    "GET /session": sessionRoute((subject) => { calls.push("session"); received = subject; return response(200, subject); }),
    "GET /me": identityRoute((subject) => { calls.push("identity"); received = subject; return response(200, subject); }),
    "POST /build": permissionRoute("release.build", (subject, event) => {
      calls.push("build"); received = { subject, event }; return response(202, { queued: true });
    }),
    "POST /logout": publicRoute(() => { calls.push("logout"); return response(204, null); }),
  });
  const handler = createDispatcher(routes, {
    caller: async () => { calls.push("caller"); return account; },
    resolveIdentity: async () => { calls.push("resolveIdentity"); return identity; },
    panelOrigins: ["https://panel.example", "https://legacy.example"],
  });
  return { calls, handler, received: () => received };
}

test("unknown routes default-deny without authentication or handler effects", async () => {
  const f = fixture();
  for (const routeKey of ["GET /unknown", "toString", "__proto__"]) {
    assert.deepEqual(await f.handler({ routeKey }), response(404, { error: "not_found" }));
  }
  assert.deepEqual(f.calls, []);
});

test("public handlers do not resolve a browser account or identity", async () => {
  const f = fixture(null, null);
  const event: Event = { requestContext: { http: { method: "GET" } }, rawPath: "/public" };
  assert.equal((await f.handler(event)).statusCode, 200);
  assert.deepEqual(f.calls, ["public"]);
  assert.equal(f.received(), event);
});

test("all protected levels reject a missing session before resolving identity", async () => {
  for (const routeKey of ["GET /session", "GET /me", "POST /build"]) {
    const f = fixture(null);
    assert.deepEqual(await f.handler({ routeKey }), response(401, { error: "invalid_or_expired_session" }));
    assert.deepEqual(f.calls, ["caller"]);
  }
});

test("session routes accept a visitor without resolving an identity", async () => {
  const f = fixture(principal, null);
  assert.equal((await f.handler({ routeKey: "GET /session" })).statusCode, 200);
  assert.deepEqual(f.calls, ["caller", "session"]);
  assert.equal(f.received(), principal);
});

test("identity and permission routes reject visitors before the feature runs", async () => {
  for (const routeKey of ["GET /me", "POST /build"]) {
    const f = fixture(principal, null);
    assert.deepEqual(await f.handler({ routeKey }), response(403, { error: "access_not_granted" }));
    assert.deepEqual(f.calls, ["caller", "resolveIdentity"]);
  }
});

test("self-scoped identity routes receive the resolved identity without extra permissions", async () => {
  const f = fixture();
  assert.equal((await f.handler({ routeKey: "GET /me" })).statusCode, 200);
  assert.deepEqual(f.calls, ["caller", "resolveIdentity", "identity"]);
  assert.equal(f.received(), viewer);
});

test("insufficient or unknown roles cannot run a privileged feature", async () => {
  for (const identity of [viewer, { ...viewer, roleId: "unknown", directGrants: ["release.build"] as const }]) {
    const f = fixture(principal, identity);
    assert.deepEqual(await f.handler({ routeKey: "POST /build" }), response(403, { error: "forbidden" }));
    assert.deepEqual(f.calls, ["caller", "resolveIdentity"]);
  }
});

test("role permissions and direct grants use the same gate and preserve the event", async () => {
  for (const identity of [{ ...viewer, roleId: "operator" }, { ...viewer, directGrants: ["release.build"] as const }]) {
    const f = fixture(principal, identity);
    const event: Event = { routeKey: "POST /build", body: "{}", pathParameters: { presetId: "industrial" } };
    assert.equal((await f.handler(event)).statusCode, 202);
    assert.deepEqual(f.calls, ["caller", "resolveIdentity", "build"]);
    assert.deepEqual(f.received(), { subject: identity, event });
  }
});

test("cookie writes, including public logout, reject an untrusted origin before any handler", async () => {
  for (const routeKey of ["POST /build", "POST /logout"]) {
    for (const cookie of [browserSessionCookieName, refreshCookieName]) {
      const f = fixture();
      const result = await f.handler({ routeKey, cookies: [`${cookie}=token`], headers: { Origin: "https://evil.example" } });
      assert.deepEqual(result, response(403, { error: "untrusted_origin" }));
      assert.deepEqual(f.calls, []);
    }
  }
});

test("both panel origins can write with cookies; bearer-only requests need no origin", async () => {
  for (const origin of ["https://panel.example", "https://legacy.example"]) {
    const f = fixture();
    assert.equal((await f.handler({
      routeKey: "POST /logout", headers: { cookie: `${browserSessionCookieName}=token`, origin },
    })).statusCode, 204);
    assert.deepEqual(f.calls, ["logout"]);
  }
  const f = fixture(principal, { ...viewer, roleId: "operator" });
  assert.equal((await f.handler({ routeKey: "POST /build", headers: { authorization: "Bearer token" } })).statusCode, 202);
});

test("route composition refuses duplicate ownership instead of silently overriding permissions", () => {
  const publicGroup = { "GET /example": publicRoute(() => response(200, null)) };
  const privateGroup = { "GET /example": permissionRoute("access.manage", () => response(200, null)) };
  assert.throws(() => composeRoutes(publicGroup, privateGroup), /duplicate API route: GET \/example/);
  const routes = composeRoutes(publicGroup);
  assert.equal(Object.isFrozen(routes), true);
  assert.equal(Object.getPrototypeOf(routes), null);
});

test("capabilities only advertise owned, composed routes", () => {
  assert.deepEqual(capabilitiesForRoutes({}), []);
  assert.deepEqual(capabilitiesForRoutes({ "POST /games/{gameId}/presets/{presetId}/builds": {} }), ["releaseBuilds"]);
  assert.deepEqual(capabilitiesForRoutes(Object.create({ "POST /games/{gameId}/presets/{presetId}/builds": {} })), []);
});
