# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Spawnpoint serves a small private gaming group. An Owner manages access and infrastructure; approved players inspect server state, start permitted game sessions and invite other players; operators additionally handle diagnostics and maintenance.

## Product Purpose

Spawnpoint makes disposable, on-demand game infrastructure usable without requiring every player to understand AWS. Success means a permitted person can understand the current state, perform an allowed action and verify its outcome without exposing infrastructure credentials or leaving paid compute running accidentally.

## Positioning

One control plane presents worlds, releases, access, invitations and session operations consistently across a Telegram bot, Telegram Mini App and ordinary browser while AWS remains the execution platform rather than the user interface.

## Operating Context

The panel is opened from Telegram on a phone and as a persistent browser tab on desktop, including large and 4K displays. Sessions are occasional and cost-sensitive. Infrastructure can be stopped while persistent worlds, releases and access data remain available.

## Capabilities and Constraints

- Telegram is the initial identity provider for both Mini App and browser sessions.
- Every action is subject to the same backend identity, role and permission checks regardless of client.
- Games contain persistent worlds; sessions temporarily bind a selected world to disposable compute.
- The interface exposes status, session controls, invitations, metrics, console, releases, backups, identities, roles, notification subscriptions and linked accounts only where the backend has real support.
- Static CloudFront hosting uses hash routes so reload and browser history preserve navigation.
- Light, dark and system theme behaviour must work in Telegram and ordinary browsers and survive reloads.
- The same interface must remain effective on phones, ordinary desktops and 4K displays.
- Empty, loading, unavailable, failed and partially delivered states are product states, not decorative placeholders.
- No control or chart may imply data or an action that the backend does not provide.

## Brand Commitments

The product name is Spawnpoint. Its established voice is direct, operational and calm. Standing visual preference recorded by the owner on 2026-09-12: the panel is built in the Google Cloud console grammar, played straight at that console's craft level: an app bar with a scope picker, a navigation drawer, resource lists that open into resource pages, Material status iconography and data tables. Spawnpoint stays recognisable through its mark, its names and its game-specific content, not through invented chrome. AWS chrome is not a reference. Since 2026-09-23 that grammar is the default skin (`console`) rather than the whole panel: a second skin, `terminal`, draws the same models as one monospace screen. Every skin keeps the same colour roles, because the owner wants the palette recognisable across their projects (recorded 2026-09-23).

## Evidence on Hand

The repository contains working API integrations, real control-plane state, access management, invitation delivery history, notification preferences and Telegram identity data. No marketing claims, testimonials or decorative image assets are required or should be invented.

## Product Principles

- Make the safe path the obvious path.
- Show observed state separately from requested action.
- Keep advanced infrastructure detail available without making it the entry point.
- Preserve one authorization model across every client.
- Prefer explicit, recoverable operations over optimistic fiction.

## Accessibility & Inclusion

All operations must be keyboard accessible, retain visible focus, avoid color-only meaning and provide touch targets suitable for Telegram's mobile webview.
