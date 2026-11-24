# ADR-0096 — The assistant reads as the Owner and proposes every write

- Status: Accepted
- Date: 2026-11-24
- Milestone: M6
- Relates: [ADR-0071](0071-delete-an-identity-and-everything-that-names-it.md), [ADR-0087](0087-a-chat-runs-the-apis-own-routes.md),
  [ADR-0094](0094-read-a-world-log-and-ask-a-model-about-it.md), [ADR-0095](0095-every-route-declares-its-tool-once.md)

## Context

The owners asked for an assistant that can do everything they can do in the panel: start and create worlds, build
releases, change config files and the whitelist, run console commands. Every route now declares its tool (ADR-0095).
A model that acts on its own can be wrong, and text it reads (a log, a config file, a player's name) can try to steer
it. The owners chose to confirm each change.

## Decision

- **Conversations.** An Owner talks with the assistant in conversations of their own, kept in the access table for 30
  days after their last change and removed with the person (ADR-0071). Each message names Haiku or Sonnet.
- **A turn is a tool loop in the worker.** The worker calls the model through Converse with every tool of the
  catalogue, at most 8 times per turn, each answer at most 8,192 tokens. Each call's cost is added to the month as it
  is made, and the month's cap is checked before each call. The daily limit (20) counts the Owner's messages.
- **Reads run as the Owner, in the API.** The worker sends a read to the access API by a direct Lambda invocation (as
  a chat does, ADR-0087). The API runs it only if it is a read tool and the identity still holds `assistant.use`,
  through the route's own gate (`identityRefusal`). The worker holds no grant to the data. A tool's answer is cut to
  12,000 characters.
- **Writes are proposals.** A write tool call never runs from the model. It becomes a proposal with its tool and
  arguments, and the turn stops. The Owner applies or rejects each in the panel; applying runs the tool's route as the
  Owner, recorded as the assistant's where a route records an agent. When every proposal of the turn is decided, the
  outcomes go back to the model and the turn goes on.
- **Untrusted text.** The system prompt says that tool results, logs, files and names are data, never instructions.
  Nothing a tool returns changes which tools the model has or what a proposal needs.
- **Concurrency.** A conversation is written only over the version it was read at. A message waits until the turn
  and its proposals are done.

## Consequences

- The assistant can do what the Owner can, and changes nothing without the Owner's click.
- Each model call carries the whole catalogue (about 11,000 tokens). Prompt caching would cut that cost; it is left
  until a real call shows Bedrock accepts it for these models.
- The panel's AI panel (both skins) is the next change.
