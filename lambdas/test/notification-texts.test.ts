import assert from "node:assert/strict";
import test from "node:test";

import { parseExecutionEvent, renderNotification } from "../src/domain/notifications.ts";

// Every branch's exact text, recorded before the renderer was split per
// state machine. A change here is a change players read.

type Case = [
  machine: string,
  status: string,
  name: string,
  fields: { input?: Record<string, unknown>; output?: Record<string, unknown>; error?: string },
  text: string | null,
];

// A child stop (a player's stop or an idle stop) never announces a refusal: the parent speaks for it.
function childStopCases(name: string): Case[] {
  const failed = `[ALARM] A stop failed (${name}) — the world may be unsaved or the backup unverified, and EC2 may still be running.`;
  return [
    ["spawnpoint-stop-server-v2", "RUNNING", name, {}, null],
    ["spawnpoint-stop-server-v2", "SUCCEEDED", name, {}, null],
    ["spawnpoint-stop-server-v2", "FAILED", name, {}, failed],
    ["spawnpoint-stop-server-v2", "TIMED_OUT", name, {}, failed],
    ["spawnpoint-stop-server-v2", "ABORTED", name, {}, failed],
    ["spawnpoint-stop-server-v2", "FAILED", name, { error: "Spawnpoint.V2StaleSession" }, null],
    ["spawnpoint-stop-server-v2", "FAILED", name, { error: "Spawnpoint.V2StopRefusedPlayersOnline" }, null],
    ["spawnpoint-stop-server-v2", "FAILED", name, { error: "Spawnpoint.HostActivityUnknown" }, `[ALARM] The world was saved and its backup verified (${name}), but host activity could not be checked. EC2 may still be running.`],
    ["spawnpoint-stop-server-v2", "FAILED", name, { error: "States.TaskFailed" }, failed],
  ];
}

const CASES: readonly Case[] = [
  ["spawnpoint-start-server-v2", "RUNNING", "op-1", {}, "[STARTING] the owner requested the server. Mods take a few minutes."],
  ["spawnpoint-start-server-v2", "FAILED", "op-1", {}, "[FAILED] Start failed (op-1). The owner can read the execution history."],
  ["spawnpoint-start-server-v2", "TIMED_OUT", "op-1", {}, "[FAILED] Start failed (op-1). The owner can read the execution history."],
  ["spawnpoint-start-server-v2", "ABORTED", "op-1", {}, "[FAILED] Start failed (op-1). The owner can read the execution history."],
  ["spawnpoint-start-server-v2", "SUCCEEDED", "op-1", {}, "[READY] Server is up."],
  ["spawnpoint-start-server-v2", "SUCCEEDED", "op-1", {"output": {"connectionAddress": "1.2.3.4:25565"}}, "[READY] Server is up: 1.2.3.4:25565"],
  ["spawnpoint-start-server-v2", "SUCCEEDED", "op-1", {"output": {"address": "5.6.7.8"}}, "[READY] Server is up: 5.6.7.8"],
  ["spawnpoint-start-server-v2", "RUNNING", "op-1", {"input": {"worldName": "Alpha"}}, "[STARTING] the owner requested Alpha. Mods take a few minutes."],
  ["spawnpoint-start-server-v2", "FAILED", "op-1", {"input": {"worldName": "Alpha"}}, "[FAILED] Start of Alpha failed (op-1). The owner can read the execution history."],
  ["spawnpoint-start-server-v2", "TIMED_OUT", "op-1", {"input": {"worldName": "Alpha"}}, "[FAILED] Start of Alpha failed (op-1). The owner can read the execution history."],
  ["spawnpoint-start-server-v2", "ABORTED", "op-1", {"input": {"worldName": "Alpha"}}, "[FAILED] Start of Alpha failed (op-1). The owner can read the execution history."],
  ["spawnpoint-start-server-v2", "SUCCEEDED", "op-1", {"input": {"worldName": "Alpha"}}, "[READY] Alpha is up."],
  ["spawnpoint-start-server-v2", "SUCCEEDED", "op-1", {"input": {"worldName": "Alpha"}, "output": {"connectionAddress": "1.2.3.4:25565"}}, "[READY] Alpha is up: 1.2.3.4:25565"],
  ["spawnpoint-start-server-v2", "SUCCEEDED", "op-1", {"input": {"worldName": "Alpha"}, "output": {"address": "5.6.7.8"}}, "[READY] Alpha is up: 5.6.7.8"],
  ["spawnpoint-start-server-v2", "RUNNING", "op-1", {"input": {"requestedBy": "identity:x"}}, "[STARTING] identity:x requested the server. Mods take a few minutes."],
  ["spawnpoint-start-server-v2", "FAILED", "op-1", {"input": {"requestedBy": "identity:x"}}, "[FAILED] Start failed (op-1). The owner can read the execution history."],
  ["spawnpoint-start-server-v2", "TIMED_OUT", "op-1", {"input": {"requestedBy": "identity:x"}}, "[FAILED] Start failed (op-1). The owner can read the execution history."],
  ["spawnpoint-start-server-v2", "ABORTED", "op-1", {"input": {"requestedBy": "identity:x"}}, "[FAILED] Start failed (op-1). The owner can read the execution history."],
  ["spawnpoint-start-server-v2", "SUCCEEDED", "op-1", {"input": {"requestedBy": "identity:x"}}, "[READY] Server is up."],
  ["spawnpoint-start-server-v2", "SUCCEEDED", "op-1", {"input": {"requestedBy": "identity:x"}, "output": {"connectionAddress": "1.2.3.4:25565"}}, "[READY] Server is up: 1.2.3.4:25565"],
  ["spawnpoint-start-server-v2", "SUCCEEDED", "op-1", {"input": {"requestedBy": "identity:x"}, "output": {"address": "5.6.7.8"}}, "[READY] Server is up: 5.6.7.8"],
  ["spawnpoint-start-server-v2", "RUNNING", "op-1", {"input": {"worldName": "", "requestedBy": "identity:x"}}, "[STARTING] identity:x requested the server. Mods take a few minutes."],
  ["spawnpoint-start-server-v2", "FAILED", "op-1", {"input": {"worldName": "", "requestedBy": "identity:x"}}, "[FAILED] Start failed (op-1). The owner can read the execution history."],
  ["spawnpoint-start-server-v2", "TIMED_OUT", "op-1", {"input": {"worldName": "", "requestedBy": "identity:x"}}, "[FAILED] Start failed (op-1). The owner can read the execution history."],
  ["spawnpoint-start-server-v2", "ABORTED", "op-1", {"input": {"worldName": "", "requestedBy": "identity:x"}}, "[FAILED] Start failed (op-1). The owner can read the execution history."],
  ["spawnpoint-start-server-v2", "SUCCEEDED", "op-1", {"input": {"worldName": "", "requestedBy": "identity:x"}}, "[READY] Server is up."],
  ["spawnpoint-start-server-v2", "SUCCEEDED", "op-1", {"input": {"worldName": "", "requestedBy": "identity:x"}, "output": {"connectionAddress": "1.2.3.4:25565"}}, "[READY] Server is up: 1.2.3.4:25565"],
  ["spawnpoint-start-server-v2", "SUCCEEDED", "op-1", {"input": {"worldName": "", "requestedBy": "identity:x"}, "output": {"address": "5.6.7.8"}}, "[READY] Server is up: 5.6.7.8"],
  ["spawnpoint-start-server", "RUNNING", "op-1-start", {}, null],
  ["spawnpoint-start-server", "FAILED", "op-1-idle-2", {}, null],
  ["spawnpoint-idle-watchdog-v2", "SUCCEEDED", "op-1", {"output": {"status": "stopped_idle"}}, "[STOPPED] Nobody online — server saved, backed up and stopped."],
  ["spawnpoint-idle-watchdog-v2", "SUCCEEDED", "op-1", {"output": {"status": "stopped_session_cap"}}, "[STOPPED] Session cap reached — server saved, backed up and stopped."],
  ["spawnpoint-idle-watchdog-v2", "SUCCEEDED", "op-1", {"output": {"status": "kept"}}, null],
  ["spawnpoint-idle-watchdog-v2", "SUCCEEDED", "op-1", {}, null],
  ["spawnpoint-idle-watchdog-v2", "RUNNING", "op-1", {}, null],
  ["spawnpoint-idle-watchdog-v2", "FAILED", "op-1", {}, "[ALARM] The idle watchdog died (op-1). If the server is up, it will not stop itself — the running-hours alarm is the backstop."],
  ["spawnpoint-idle-watchdog-v2", "TIMED_OUT", "op-1", {}, "[ALARM] The idle watchdog died (op-1). If the server is up, it will not stop itself — the running-hours alarm is the backstop."],
  ["spawnpoint-idle-watchdog-v2", "ABORTED", "op-1", {}, "[ALARM] The idle watchdog died (op-1). If the server is up, it will not stop itself — the running-hours alarm is the backstop."],
  ["spawnpoint-idle-watchdog-v2", "SUCCEEDED", "op-1", {"input": {"worldName": "Alpha"}, "output": {"status": "stopped_idle"}}, "[STOPPED] Alpha: nobody online — saved, backed up and stopped."],
  ["spawnpoint-idle-watchdog-v2", "SUCCEEDED", "op-1", {"input": {"worldName": "Alpha"}, "output": {"status": "stopped_session_cap"}}, "[STOPPED] Alpha: session cap reached — saved, backed up and stopped."],
  ["spawnpoint-idle-watchdog-v2", "SUCCEEDED", "op-1", {"input": {"worldName": "Alpha"}, "output": {"status": "kept"}}, null],
  ["spawnpoint-idle-watchdog-v2", "SUCCEEDED", "op-1", {"input": {"worldName": "Alpha"}}, null],
  ["spawnpoint-idle-watchdog-v2", "RUNNING", "op-1", {"input": {"worldName": "Alpha"}}, null],
  ["spawnpoint-idle-watchdog-v2", "FAILED", "op-1", {"input": {"worldName": "Alpha"}}, "[ALARM] The idle watchdog died (op-1). If the server is up, it will not stop itself — the running-hours alarm is the backstop."],
  ["spawnpoint-idle-watchdog-v2", "TIMED_OUT", "op-1", {"input": {"worldName": "Alpha"}}, "[ALARM] The idle watchdog died (op-1). If the server is up, it will not stop itself — the running-hours alarm is the backstop."],
  ["spawnpoint-idle-watchdog-v2", "ABORTED", "op-1", {"input": {"worldName": "Alpha"}}, "[ALARM] The idle watchdog died (op-1). If the server is up, it will not stop itself — the running-hours alarm is the backstop."],
  ["spawnpoint-idle-watchdog", "FAILED", "op-1-cap-3", {}, "[ALARM] The idle watchdog died (op-1-cap-3). If the server is up, it will not stop itself — the running-hours alarm is the backstop."],
  ["spawnpoint-stop-server-v2", "RUNNING", "op-1", {}, null],
  ["spawnpoint-stop-server-v2", "SUCCEEDED", "op-1", {}, null],
  ["spawnpoint-stop-server-v2", "FAILED", "op-1", {}, "[ALARM] A stop failed (op-1) — the world may be unsaved or the backup unverified, and EC2 may still be running."],
  ["spawnpoint-stop-server-v2", "TIMED_OUT", "op-1", {}, "[ALARM] A stop failed (op-1) — the world may be unsaved or the backup unverified, and EC2 may still be running."],
  ["spawnpoint-stop-server-v2", "ABORTED", "op-1", {}, "[ALARM] A stop failed (op-1) — the world may be unsaved or the backup unverified, and EC2 may still be running."],
  ["spawnpoint-stop-server-v2", "FAILED", "op-1", {"error": "Spawnpoint.V2StaleSession"}, null],
  ["spawnpoint-stop-server-v2", "FAILED", "op-1", {"error": "Spawnpoint.V2StopRefusedPlayersOnline"}, "[STOP CANCELLED] Players are online, so the server keeps running. Nothing was lost."],
  ["spawnpoint-stop-server-v2", "FAILED", "op-1", {"error": "Spawnpoint.HostActivityUnknown"}, "[ALARM] The world was saved and its backup verified (op-1), but host activity could not be checked. EC2 may still be running."],
  ["spawnpoint-stop-server-v2", "FAILED", "op-1", {"error": "States.TaskFailed"}, "[ALARM] A stop failed (op-1) — the world may be unsaved or the backup unverified, and EC2 may still be running."],
  ...childStopCases("op-1-stop"),
  ...childStopCases("op-1-idle-1"),
  ["spawnpoint-drain-host-v2", "RUNNING", "op-1", {"input": {"hostId": "i-0abc"}}, null],
  ["spawnpoint-drain-host-v2", "RUNNING", "op-1-stop", {}, null],
  ["spawnpoint-drain-host-v2", "SUCCEEDED", "op-1", {"input": {"hostId": "i-0abc"}}, null],
  ["spawnpoint-drain-host-v2", "SUCCEEDED", "op-1-stop", {}, null],
  ["spawnpoint-drain-host-v2", "FAILED", "op-1", {"input": {"hostId": "i-0abc"}}, "[ALARM] Fleet drain failed for i-0abc (op-1). EC2 may still be billed; the scheduled Fleet sweep will retry or flag it for review."],
  ["spawnpoint-drain-host-v2", "FAILED", "op-1-stop", {}, "[ALARM] Fleet drain failed for unknown host (op-1-stop). EC2 may still be billed; the scheduled Fleet sweep will retry or flag it for review."],
  ["spawnpoint-drain-host-v2", "TIMED_OUT", "op-1", {"input": {"hostId": "i-0abc"}}, "[ALARM] Fleet drain failed for i-0abc (op-1). EC2 may still be billed; the scheduled Fleet sweep will retry or flag it for review."],
  ["spawnpoint-drain-host-v2", "TIMED_OUT", "op-1-stop", {}, "[ALARM] Fleet drain failed for unknown host (op-1-stop). EC2 may still be billed; the scheduled Fleet sweep will retry or flag it for review."],
  ["spawnpoint-drain-host-v2", "ABORTED", "op-1", {"input": {"hostId": "i-0abc"}}, "[ALARM] Fleet drain failed for i-0abc (op-1). EC2 may still be billed; the scheduled Fleet sweep will retry or flag it for review."],
  ["spawnpoint-drain-host-v2", "ABORTED", "op-1-stop", {}, "[ALARM] Fleet drain failed for unknown host (op-1-stop). EC2 may still be billed; the scheduled Fleet sweep will retry or flag it for review."],
  ["spawnpoint-promote-release", "RUNNING", "op-1", {}, "[DEPLOYING] Release ? is being promoted."],
  ["spawnpoint-promote-release", "FAILED", "op-1", {}, "[FAILED] Promotion of ? failed (op-1). The pointer tells the truth; see the runbook."],
  ["spawnpoint-promote-release", "TIMED_OUT", "op-1", {}, "[FAILED] Promotion of ? failed (op-1). The pointer tells the truth; see the runbook."],
  ["spawnpoint-promote-release", "ABORTED", "op-1", {}, "[FAILED] Promotion of ? failed (op-1). The pointer tells the truth; see the runbook."],
  ["spawnpoint-promote-release", "SUCCEEDED", "op-1", {"output": {"status": "promoted"}}, "[DEPLOYED] Release ? is live. /pack for the new archive."],
  ["spawnpoint-promote-release", "SUCCEEDED", "op-1", {"output": {"status": "promoted", "server": "running"}}, "[DEPLOYED] Release ? is live and the server is up. /pack for the new archive."],
  ["spawnpoint-promote-release", "SUCCEEDED", "op-1", {"output": {"status": "rolled_back"}}, "[ROLLED BACK] Release ? failed its health check and was rolled back to the previous release. Nothing to update."],
  ["spawnpoint-promote-release", "SUCCEEDED", "op-1", {"output": {"status": "rolled_back", "active_release": "r-41"}}, "[ROLLED BACK] Release ? failed its health check and was rolled back to r-41. Nothing to update."],
  ["spawnpoint-promote-release", "SUCCEEDED", "op-1", {"output": {"status": "already_active"}}, null],
  ["spawnpoint-promote-release", "SUCCEEDED", "op-1", {"output": {"status": "other"}}, null],
  ["spawnpoint-promote-release", "SUCCEEDED", "op-1", {}, null],
  ["spawnpoint-promote-release", "RUNNING", "op-1", {"input": {"release": "r-42"}}, "[DEPLOYING] Release r-42 is being promoted."],
  ["spawnpoint-promote-release", "FAILED", "op-1", {"input": {"release": "r-42"}}, "[FAILED] Promotion of r-42 failed (op-1). The pointer tells the truth; see the runbook."],
  ["spawnpoint-promote-release", "TIMED_OUT", "op-1", {"input": {"release": "r-42"}}, "[FAILED] Promotion of r-42 failed (op-1). The pointer tells the truth; see the runbook."],
  ["spawnpoint-promote-release", "ABORTED", "op-1", {"input": {"release": "r-42"}}, "[FAILED] Promotion of r-42 failed (op-1). The pointer tells the truth; see the runbook."],
  ["spawnpoint-promote-release", "SUCCEEDED", "op-1", {"input": {"release": "r-42"}, "output": {"status": "promoted"}}, "[DEPLOYED] Release r-42 is live. /pack for the new archive."],
  ["spawnpoint-promote-release", "SUCCEEDED", "op-1", {"input": {"release": "r-42"}, "output": {"status": "promoted", "server": "running"}}, "[DEPLOYED] Release r-42 is live and the server is up. /pack for the new archive."],
  ["spawnpoint-promote-release", "SUCCEEDED", "op-1", {"input": {"release": "r-42"}, "output": {"status": "rolled_back"}}, "[ROLLED BACK] Release r-42 failed its health check and was rolled back to the previous release. Nothing to update."],
  ["spawnpoint-promote-release", "SUCCEEDED", "op-1", {"input": {"release": "r-42"}, "output": {"status": "rolled_back", "active_release": "r-41"}}, "[ROLLED BACK] Release r-42 failed its health check and was rolled back to r-41. Nothing to update."],
  ["spawnpoint-promote-release", "SUCCEEDED", "op-1", {"input": {"release": "r-42"}, "output": {"status": "already_active"}}, null],
  ["spawnpoint-promote-release", "SUCCEEDED", "op-1", {"input": {"release": "r-42"}, "output": {"status": "other"}}, null],
  ["spawnpoint-promote-release", "SUCCEEDED", "op-1", {"input": {"release": "r-42"}}, null],
  ["spawnpoint-promote-release", "RUNNING", "op-1-rollback", {}, null],
  ["spawnpoint-promote-release", "SUCCEEDED", "op-1-rollback-stop", {"input": {"release": "r-1"}, "output": {"status": "promoted"}}, null],
  ["spawnpoint-world-lifecycle", "FAILED", "op-1", {}, null],
  ["spawnpoint-unknown", "SUCCEEDED", "op-1", {}, null],
];

test("every notification text stays byte-identical", () => {
  for (const [machine, status, name, fields, text] of CASES) {
    const event = parseExecutionEvent({
      stateMachineArn: `arn:aws:states:eu-central-1:123456789012:stateMachine:${machine}`,
      status,
      name,
      input: fields.input === undefined ? undefined : JSON.stringify(fields.input),
      output: fields.output === undefined ? undefined : JSON.stringify(fields.output),
      error: fields.error,
    });
    assert.ok(event, `${machine} ${status} ${name} must parse`);
    assert.equal(renderNotification(event), text, `${machine} ${status} ${name} ${JSON.stringify(fields)}`);
  }
});
