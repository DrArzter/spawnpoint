# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Spawnpoint serves a small private gaming group. An Owner manages access and infrastructure; approved players inspect server state, start permitted game sessions and invite other players; operators additionally handle diagnostics and maintenance.

## Product Purpose

Spawnpoint makes disposable, on-demand game infrastructure usable without requiring every player to understand AWS. Success means a permitted person can understand the current state, perform an allowed action and verify its outcome without exposing infrastructure credentials or leaving paid compute running accidentally.

## Positioning

One control plane presents worlds, releases, access, invitations and session operations consistently across a Telegram bot, Telegram Mini App, ordinary browser and agents connected through MCP, while AWS remains the execution platform rather than the user interface.

## Operating Context

The panel is opened from Telegram on a phone and as a persistent browser tab on desktop, including large and 4K displays. Sessions are occasional and cost-sensitive. Infrastructure can be stopped while persistent worlds, releases and access data remain available.

## Capabilities and Constraints

- Email and password is the default way in; Telegram (Mini App and browser) and, where a deployment configures it, Google are alternatives, and every provider issues the same session.
- Every action is subject to the same backend identity, role and permission checks regardless of client.
- Games contain persistent worlds; sessions temporarily bind a selected world to disposable compute.
- The interface exposes status, session controls, invitations, metrics, console, releases, backups, game settings, mod and backup downloads, identities, roles, notification subscriptions and linked accounts only where the backend has real support.
- Static CloudFront hosting uses hash routes so reload and browser history preserve navigation.
- Light, dark and system theme behaviour must work in Telegram and ordinary browsers and survive reloads.
- The same interface must remain effective on phones, ordinary desktops and 4K displays.
- Empty, loading, unavailable, failed and partially delivered states are product states, not decorative placeholders.
- No control or chart may imply data or an action that the backend does not provide.

## Brand Commitments

The product name is Spawnpoint. Its established voice is direct, operational and calm. Visual direction, recorded by the owner on 2026-11-21 ([ADR-0072](../docs/adr/0072-draw-the-console-in-the-c-a-grammar.md)): the default skin (`console`) is drawn in the **C+A** grammar. It has the flavour of the AWS console without its brand: an ink top bar with the game as a pill switcher, a slim icon rail, a game home of widget cards, dense resource tables that open into resource pages whose breadcrumb is the title, bold card headers with counts, status as an icon and a label, and a flashbar for operations. It uses no AWS logo, orange, font or names. Spawnpoint stays recognisable through its mark, its names and its game-specific content. The owner rules that bind every page are in `web/DESIGN.md`. A second skin, `terminal`, draws the same models as one monospace screen ([ADR-0059](../docs/adr/0059-separate-the-console-into-bones-and-skins.md)); it is switched off, so the console is the only face people see ([ADR-0106](../docs/adr/0106-a-skin-can-be-switched-off.md)). Both skins keep the same status colour roles (ok, warning, error, progress, off). The console's accent is iris by default, and a colour picked in Profile overrides it.

## Evidence on Hand

The repository contains working API integrations, real control-plane state, access management, invitation delivery history, notification preferences and Telegram identity data. No marketing claims, testimonials or decorative image assets are required or should be invented.

## Product Principles

- Make the safe path the obvious path.
- Show observed state separately from requested action.
- Keep advanced infrastructure detail available without making it the entry point.
- Preserve one authorization model across every client.
- Prefer explicit, recoverable operations over optimistic fiction.
- One word per thing. The domain terms are in [CONTEXT.md](../CONTEXT.md); the retired spellings (for example *save* for *world*) stay retired.
- Explain a word once, where it is read, and never in a line that repeats on every row. A fact about a record, such as a date, a release or an instance type, shows under the value. An explanation of what a row means sits behind the label, on the help mark. Nothing explains what the label already says.

## Accessibility & Inclusion

All operations must be keyboard accessible, retain visible focus, avoid color-only meaning and provide touch targets suitable for Telegram's mobile webview.
