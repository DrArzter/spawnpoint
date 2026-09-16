# Glossary

One word per thing. If a word here disagrees with a word in the product, the product is wrong.

This file exists because the panel called one entity by two names in a single screen: the page was titled *Worlds*
while its description read *"2 saves across 2 presets"* and its button said *"Create save"*. The entity is a **world**.

## The things a player sees

| Term | What it is | Not to be confused with |
| --- | --- | --- |
| **Game** | A title Spawnpoint supports: Minecraft, Factorio. Owns presets and worlds. | — |
| **World** | One named game world: its own address, its own save lineage, its own release. What a player joins. | The **host** it runs on. A world exists while no host does. Never called a *save* — that word is the verb. |
| **Wipe** | One generation of a world. A new wipe opens a new generation and keeps every backup of the old one. | A deletion. Nothing is overwritten. |
| **Session** | One run of one world on a host, from start to verified stop. | The **login session** of a person in the panel. |
| **Address** | Where the game client connects. Supplied per world by a connectivity strategy. | — |

## The things an operator sees

| Term | What it is | Not to be confused with |
| --- | --- | --- |
| **Preset** | The recipe for a world, authored in Git. Builds into releases. | A **release**: the preset is the source, the release is the artefact. |
| **Release** | One immutable build of a preset. A wipe runs exactly one release. | A deployment of Spawnpoint itself. |
| **Host** | The machine a session runs on. Started on demand, stopped when nobody plays. | A **world**. The host is infrastructure; the world is the thing with a name and players. |
| **Operation** | One long-running action with a recorded start and end: start, stop, wipe, restore, purge. | — |
| **Backup** | A verified archive of one wipe in S3, checksummed and listed per wipe. | A snapshot of the host. |

## Access

| Term | What it is | Not to be confused with |
| --- | --- | --- |
| **Identity** | A person in Spawnpoint, independent of which provider proved them. | The **account** at the provider, which is a link on the identity. |
| **Role** | A named set of permissions. Every identity holds exactly one. | — |
| **Permission** | One named right, such as `session.start`. | — |
| **Direct grant** | A single permission added to one identity on top of its role. | A role. A grant is an exception, not a class. |

## Spellings that were retired

| Retired | Use instead | Why |
| --- | --- | --- |
| **Save** (the noun) | World | A second word for the same entity. It described the data, and the panel used it for the thing. The verb stays: stopping a session saves the world. |
| **Compute host**, **shared game host** | Host | Three spellings of one machine. |

## How to explain a term in the panel

A word that needs explaining gets explained once, where it is read, and never in a line that repeats on every row:

- A **fact** about this record — a date, a release, an instance type — is visible under the value.
- An **explanation** of what the row means sits behind the label, on the help mark.
- Nothing explains what the label already says.
