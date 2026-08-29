# ADR-0038 — Claim an invitation once before Telegram delivery

- Status: Accepted
- Date: 2026-08-29

EventBridge is at-least-once and Telegram `sendMessage` has no idempotency key, so retrying an ambiguous delivery can invite the same people twice. Spawnpoint therefore stores an invitation as `READY`; the notifier must atomically change it to `DELIVERING` before sending, and only that claimant may continue. It then records `DELIVERED`, `PARTIAL`, `FAILED`, or `NO_RECIPIENTS` with target counts. A failure after the claim is visible but is not automatically retried; an intentional resend creates a new invitation.

This chooses duplicate prevention and truthful operator-visible outcomes over transparent retry of transient Telegram failures. Invitation creation, EventBridge acceptance, and notification delivery remain three separate facts.
