---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/screens/WorldsScreen.tsx","src/screens/WorldScreen.tsx","src/screens/ReleasesScreen.tsx","src/screens/AccessScreen.tsx","src/screens/ConsoleScreen.tsx","src/screens/MetricsScreen.tsx","src/screens/ProfileScreen.tsx"]
---

# Surface brief: the Spawnpoint console

Scope: the whole web panel as one surface: app shell, Worlds list and world page, Releases, Access, Console, Metrics, Profile, sign-in. Mode: Operate.

Audience and job: a five-person private gaming group. Players read which game is online and where to connect, start or stop a session, invite others. The owner and operators handle wipes, backups, restores, releases, access requests, roles and subscriptions. Opened from Telegram on a phone and as a desktop browser tab, up to 4K.

Constraints: hash routes; light, dark and system theme inside Telegram and ordinary browsers; every action gated by the session role; no control implies data or an action the backend lacks; empty, loading, error and partial states are product states; one shared compute host, so session state is observed per game, not per world.

User pins (2026-09-12): "GCP style", full redesign; the incumbent look (rail, breadcrumb pickers, cobalt, 12 px surfaces, Inter) is anti-reference, not authority.

## Direction contract

THESIS: Spawnpoint is a resource console in the Google Cloud grammar: a global scope chip, a navigation drawer, a worlds list that opens into a world page, and every fact on a labelled detail row. It refuses the gamer dashboard of neon stat cards around a giant Start button, and it refuses the incumbent's single-world command surface behind breadcrumb pickers.

OWN-WORLD: Google Cloud console materials. White app bar and drawer over a Grey-50 canvas, hairline borders (#dadce0 light, #3c4043 dark), 8 px cards, 4 px controls, Google Blue 600 (#1a73e8; #8ab4f8 in dark) for actions, links and selection only. Status is a Material filled status icon with a label, never colour alone: green check_circle, blue progress ring, grey stop circle, red error, amber warning. Type: Google Sans Flex for page and section titles at 400/500, Roboto for body and controls (14/13/12 px), Roboto Mono with tabular figures for IDs, addresses, checksums and times. Flat surfaces; one 8 dp shadow reserved for menus, dialogs, sheets and the snackbar. Underline tabs, 48 px table rows with hairline rules, 40 px text and outlined buttons.

STORY: A player opens the panel, sees at once which game is online and the address to connect to, copies it, or starts the world they want after a dialog that names the billed cost. An owner opens a world, reads its wipes, backups and releases, restores or archives with a typed confirmation where it is destructive, approves access requests, and watches each requested operation appear in the operations table until it completes.

FIRST VIEWPORT: Desktop 1440: a 64 px app bar with menu, the Spawnpoint mark, the game scope chip (project-picker grammar), theme toggle and avatar. A 256 px drawer with icon-and-label destinations filtered by permission. Content: the "Worlds" title row with Refresh and Create save; a one-row host card (status icon, host name, instance type, zone, launched); then the worlds table for the scoped game: each row a status icon, the world name as a link, preset and active release, current wipe, connectivity and address with copy, and the row's Start or Stop text button plus an overflow menu (Details, Releases, Invite). The primary action is that row button. Mobile 390: a 56 px bar, the drawer behind the menu button, the host card stacks, rows become stacked records with the action row last.

FORM: The user-pinned world is Google Cloud console (candidate 1 of my grounded list). The roll assigned candidate 6, the hosting-panel tradition (server list opening into a server page, console at hand); its topology and ritual bind where the pin leaves the brief open, its materials are translated into the pinned world. Seed key cd4da964. Raises, one per challenger: tabular-data discipline (ikeda-datamatics: monospace tabular figures, right-aligned numeric columns); drawn unlit states (seven-segment: Stopped, Archived, Not created and "no address" are designed ghost states, never blank cells); one-pull deployment (Miura sheet: a row or chip opens into complete detail in one action, and narrow screens deploy stepwise without dropping fields); desired-and-observed pairs (tensegrity: desired state beside observed state, desired release beside active release); a fully committed terminal grammar on the Console (starship terminal, competitive: typed command, acknowledged reply, standby cursor, amber for danger); constant-scale labelling (Busytown: every value carries its label, every icon button carries a name).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Signature interaction: the game scope chip opens the scope dialog (search field, each game with its session status and world count); choosing a game re-scopes the whole console and rewrites the hash. Motion grammar: 150 to 200 ms ease-out on drawer, menu, dialog, sheet and snackbar; the only continuous motion is the progress ring of a transitioning state; no load choreography; reduced motion removes transitions and keeps a static ring.

Unresolved: whether Console keeps its own destination once the RCON gateway exists. The README screen table was updated with the build on 2026-09-13.
