import assert from "node:assert/strict";
import test from "node:test";

import { requestBody } from "../src/access/request-body.ts";

test("request bodies preserve API Gateway text payloads", () => {
  assert.equal(requestBody({ body: "grant_type=authorization_code" }), "grant_type=authorization_code");
});

test("request bodies decode API Gateway binary payloads", () => {
  const body = "grant_type=authorization_code&code=opaque";
  assert.equal(requestBody({ body: Buffer.from(body).toString("base64"), isBase64Encoded: true }), body);
});
