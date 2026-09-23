import assert from "node:assert/strict";
import test from "node:test";

import { describeProviderSignInFailure, describeRegistrationFailure, describeSignInFailure, isLoginProviderId, PASSWORD_MINIMUM_LENGTH } from "../src/lib/signin.ts";

test("a refused sign-in never says which half was wrong", () => {
  const message = describeSignInFailure(401, "invalid_or_expired_password_login");
  assert.match(message, /do not match/);
  assert.doesNotMatch(message, /email is|password is/);
});

test("a deployment without the route reads as not offered, not as broken", () => {
  assert.match(describeSignInFailure(404, "not_found"), /not offered/);
  assert.match(describeRegistrationFailure(404, "not_found"), /not offered/);
  assert.match(describeSignInFailure(500, undefined), /Try again/);
});

test("registration refusals are read back in the reader's language", () => {
  assert.match(describeRegistrationFailure(400, "password_too_short"), new RegExp(`at least ${PASSWORD_MINIMUM_LENGTH}`));
  assert.match(describeRegistrationFailure(400, "invalid_email"), /valid email/);
  assert.match(describeRegistrationFailure(409, "email_already_registered"), /Sign in instead/);
  assert.match(describeRegistrationFailure(502, "boom"), /could not be created/);
});

test("only the known providers are recognised", () => {
  assert.equal(isLoginProviderId("telegram"), true);
  assert.equal(isLoginProviderId("google"), true);
  assert.equal(isLoginProviderId("password"), true);
  assert.equal(isLoginProviderId("discord"), false);
  assert.equal(isLoginProviderId(1), false);
});

test("a provider that is not deployed reads as not offered; anything else asks to start again", () => {
  assert.match(describeProviderSignInFailure("Google", 404, "not_found"), /Google sign-in is not offered/);
  assert.match(describeProviderSignInFailure("Google", 401, "invalid_or_expired_google_login"), /Google could not verify/);
  assert.match(describeProviderSignInFailure("Telegram", 500, undefined), /Telegram could not verify/);
});
