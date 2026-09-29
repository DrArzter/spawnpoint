import assert from "node:assert/strict";
import test from "node:test";

import { configFromEnvironment, SpawnpointClient } from "../dist/client.js";

test("configuration requires one authentication method", () => {
  assert.throws(() => configFromEnvironment({
    SPAWNPOINT_API_URL: "https://api.example.test",
    SPAWNPOINT_PANEL_URL: "https://panel.example.test",
  }), /SPAWNPOINT_SESSION_COOKIE/);
});

test("a bare session secret becomes the named secure cookie", () => {
  const config = configFromEnvironment({
    SPAWNPOINT_API_URL: "https://api.example.test/",
    SPAWNPOINT_PANEL_URL: "https://panel.example.test/",
    SPAWNPOINT_SESSION_COOKIE: "session-secret",
  });
  assert.equal(config.apiUrl, "https://api.example.test");
  assert.equal(config.panelUrl, "https://panel.example.test");
  assert.equal(config.sessionCookie, "__Host-spawnpoint.session=session-secret");
});

test("the client signs in, keeps the HttpOnly cookie, and supplies the trusted origin", async () => {
  const requests = [];
  const mockFetch = async (input, init = {}) => {
    requests.push({ url: String(input), method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body ?? "" });
    if (String(input).endsWith("/auth/password")) {
      return new Response('{"authenticated":true}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "__Host-spawnpoint.session=issued-secret; Path=/; HttpOnly; Secure; SameSite=Strict",
        },
      });
    }
    return new Response('{"games":[]}', { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new SpawnpointClient({
    apiUrl: "https://api.example.test",
    panelUrl: "https://panel.example.test",
    email: "owner@example.test",
    password: "not-logged",
  }, mockFetch);

  assert.deepEqual(await client.request("/control-plane"), { games: [] });
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[0].body), { email: "owner@example.test", password: "not-logged" });
  assert.equal(requests[1].headers.get("cookie"), "__Host-spawnpoint.session=issued-secret");
  assert.equal(requests[1].headers.get("origin"), "https://panel.example.test");
});
