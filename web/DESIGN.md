---
name: Spawnpoint Console
description: A resource console in the Google Cloud console grammar — scope chip, drawer, worlds list opening into a world page.
colors:
  canvas: "#f8f9fa"
  surface: "#ffffff"
  surface-variant: "#f1f3f4"
  outline: "#dadce0"
  outline-strong: "#80868b"
  ink: "#202124"
  ink-secondary: "#5f6368"
  primary: "#1a73e8"
  primary-hover: "#1967d2"
  primary-pressed: "#185abc"
  primary-container: "#e8f0fe"
  success: "#1e8e3e"
  warning: "#f9ab00"
  error: "#d93025"
  info: "#1a73e8"
typography:
  display-hero:
    fontFamily: "Google Sans Flex, Google Sans, Roboto, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "44px"
    fontWeight: 400
    lineHeight: "52px"
    letterSpacing: "-0.01em"
  display-hero-phone:
    fontFamily: "Google Sans Flex, Google Sans, Roboto, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "32px"
    fontWeight: 400
    lineHeight: "40px"
  display:
    fontFamily: "Google Sans Flex, Google Sans, Roboto, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 400
    lineHeight: "36px"
  title:
    fontFamily: "Google Sans Flex, Google Sans, Roboto, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 400
    lineHeight: "32px"
  title-dialog:
    fontFamily: "Google Sans Flex, Google Sans, Roboto, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 400
    lineHeight: "28px"
  title-sheet:
    fontFamily: "Google Sans Flex, Google Sans, Roboto, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 500
    lineHeight: "28px"
  headline:
    fontFamily: "Google Sans Flex, Google Sans, Roboto, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: "24px"
  subtitle:
    fontFamily: "Roboto, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: "24px"
  app-bar-title:
    fontFamily: "Google Sans Flex, Google Sans, Roboto, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 500
    lineHeight: "24px"
  group-title:
    fontFamily: "Roboto, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: "20px"
  body:
    fontFamily: "Roboto, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  body-reading:
    fontFamily: "Roboto, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "22px"
  label:
    fontFamily: "Roboto, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "18px"
  caption:
    fontFamily: "Roboto, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
  mono:
    fontFamily: "Roboto Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
    fontFeature: "tabular-nums"
  mono-small:
    fontFamily: "Roboto Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
    fontFeature: "tabular-nums"
rounded:
  indicator: "2px"
  tab-indicator: "3px"
  control: "4px"
  card: "8px"
  switch: "10px"
  dialog: "12px"
  nav-item: "20px"
  pill: "999px"
spacing:
  gutter: "24px"
  gutter-mobile: "16px"
  control-height: "36px"
  row-height: "48px"
  bar-height: "64px"
  bar-height-mobile: "56px"
  drawer-width: "256px"
  rail-width: "72px"
components:
  button-filled:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    height: "{spacing.control-height}"
    padding: "0 16px"
  button-filled-hover:
    backgroundColor: "{colors.primary-hover}"
  button-outlined:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.control}"
    height: "{spacing.control-height}"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.primary}"
    rounded: "{rounded.control}"
  button-danger:
    backgroundColor: "{colors.error}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "28px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
    padding: "16px 20px"
---

# Design System: Spawnpoint Console

## Overview

**Creative North Star: "The Hosting Panel"**

Spawnpoint is played straight in the Google Cloud console grammar: an app bar carrying a scope chip, a navigation drawer, a worlds list that opens into a world page, and every fact placed on a labelled detail row. It is a resource console, not a game dashboard — it refuses neon stat cards around a giant Start button, and it refuses the discarded incumbent's single-world command surface behind a breadcrumb picker. Depth is conveyed by hairline borders and tonal fills, not by neumorphic or offset shadows; the one reserved shadow is functional, not decorative, and appears only on temporary top-layer surfaces (menu, dialog, sheet, snackbar).

The content pane has no max width by design: it fills wide and 4K viewports the way the real Cloud console's resource tables do. Density comes from a 48px table row rhythm, an underline-tab pattern, and status rows that never rely on colour alone.

**Key Characteristics:**
- White app bar and drawer over a Grey-50 canvas, hairline borders throughout.
- Google Blue reserved for actions, links and selection only — never decoration.
- Status is always an icon plus a label; unlit states (Archived, Not created) are drawn on purpose, not left blank.
- Flat surfaces at rest; one shadow vocabulary for transient top-layer chrome only.
- No content-pane max-width: tables and detail pages fill the viewport.

## Colors

The palette is a light, hairline-bordered neutral field with a single blue accent; the dark theme swaps in the same roles at inverted lightness, never new hues.

### Primary
- **Google Blue** (`#1a73e8`; `#8ab4f8` in dark): actions, links, selection, focus rings, active drawer item, active tab underline. Confined to controls and state — not used as a page background or card fill.

### Neutral
- **Canvas Grey** (`#f8f9fa`; `#202124` in dark): page background, distinct from surface white.
- **Surface White** (`#ffffff`; `#2d2e31` in dark): app bar, drawer, cards, dialogs, tables.
- **Surface Variant** (`#f1f3f4`; `#3c4043` in dark): table-group header rows, code chips, empty-state icon well.
- **Hairline Outline** (`#dadce0`; `#3c4043` in dark): every card border, table rule, divider.
- **Ink** (`#202124`; `#e8eaed` in dark) / **Ink Secondary** (`#5f6368`; `#9aa0a6` in dark): primary and secondary text, always this pairing — no third grey step.

### Status roles (paired with Material icon + label, never colour alone)
- **Success** (`#1e8e3e`; `#81c995` dark): ok / running.
- **Warning** (`#f9ab00`; `#fdd663` dark): warning, the demo-mode badge in the app bar. Warning text on the warning container is a darker ink (`#9e5200`), chosen so 12px labels clear 4.5:1.
- **Error** (`#d93025`; `#f28b82` dark): error, destructive actions.
- **Info** (`#1a73e8`; `#8ab4f8` dark): info banners — shares the primary hue by design.
- **Unlit** (ink-secondary): off, unknown, ready, archived, absent, pending statuses render in secondary ink with a dedicated Material glyph — never as empty text.

### Named Rules
**The Icon-Plus-Label Rule.** Every status (`ok`, `progress`, `off`, `unknown`, `ready`, `error`, `warning`, `info`, `archived`, `absent`, `pending`) pairs a Material filled glyph with a text label (`.status`, `Status.tsx`). Colour alone never carries meaning.

**The Drawn Unlit State Rule.** Archived (`do_not_disturb_on`) and Not created (`add_circle_outline`) are designed ghost states with their own icon and secondary-ink colour, not a blank table cell. Ghost text (`.ghost`, `.secondary`) uses ink-secondary, never a lighter opacity trick.

## Typography

**Display/Title Font:** Google Sans Flex 400/500 (falls back to Google Sans, then Roboto).
**Body Font:** Roboto 400/500/700.
**Mono Font:** Roboto Mono 400/500, tabular figures.

All three load from Google Fonts in `index.html`; system sans/monospace stacks are the fallback chain, not a substitute identity.

**Character:** Google Sans Flex carries page and dialog titles at a calm, unweighted 400; Roboto carries every control, label and body line; Roboto Mono marks anything that must be compared or copied precisely — IDs, addresses, checksums, timestamps.

### Hierarchy
- **Display, front door only** (Google Sans Flex 400, 44px/52px, tracking -0.01em; 32px/40px under 960px): the single headline of the landing page (`.landing-copy h1`). No console page uses it.
- **Title** (Google Sans Flex 400, 24px/32px `h1`; 500 at 20px/28px for sheet headers; 22px/28px for dialog headers): page and world titles.
- **Headline** (Google Sans Flex 400, 18px/24px `h2`): card and section headers, empty-state headline.
- **Subtitle** (Roboto 500, 16px/24px `h3`): card-header titles. Detail-group titles inside a card step down to 14px/20px, and the app-bar wordmark is Google Sans Flex 500 at 20px/24px (18px under 960px, hidden under 600px).
- **Body** (Roboto 400, 14px/20px): default body copy, details values, dialog content (max 60–80ch). The one variant is 14px/22px for running paragraphs in a measured column (`.landing-facts dd`), where 20px sets too tight.
- **Label** (Roboto 500, 12–13px): field labels, table headers, drawer section labels, chip text.
- **Mono/Data** (Roboto Mono 400/500, 12–13px, tabular-nums): IDs, addresses, checksums, terminal grammar, world-name subtitles.

### Named Rules
**The Three-Face Rule.** Titles are Google Sans Flex, everything functional is Roboto, everything precise is Roboto Mono. No component borrows a fourth face or a system display font.

## Layout

The shell is app bar (sticky, 64px; 56px under 959px) over a body split into drawer and content pane. The drawer is 256px wide and full height; between 960px and 1279px it collapses to a 72px icon rail (`data-rail`) until the user chooses to pin it open; under 959px it becomes a fixed modal panel behind a scrim, triggered by the menu button, with the icon-rail state expanding back to a labelled 256px list inside the modal.

The content pane (`.main`) has **no max-width**: it fills the available viewport by design, from a narrow phone to a 4K desktop, matching the real Cloud console's resource-table pages. Page gutter is 24px (16px under 959px).

The front door (`#/`, `LandingScreen`) is the one surface with a measure: its content sits in a centred `min(1120px, 100% - 2 * gutter)` column under the same app bar, with the sign-in button or the signed-in avatar menu at the bar's right and no drawer. Its product shot (`.shot`) is a still of the console built from the console's own status, card and avatar components, captioned as example data; nothing inside it is interactive.

Tables run a 48px row rhythm with hairline rules between rows. Below 600px, each `.table-wrap` (a `container-type: inline-size` container) switches its table to a stacked record layout: the header row hides, each cell becomes a label/value pair from `data-label`, and the action row moves to the end of the stack. This is a container query, not a page media query — it fires per-table regardless of viewport.

Touch targets grow twice: under 959px `.icon-btn-small` and `.btn-small` gain height; under any coarse pointer (`@media (pointer: coarse)`), buttons, icon buttons, inline selects, tabs and menu items step up to a 44px minimum (fields to 44px with 16px font, to avoid iOS zoom).

### Breakpoints
Four steps, and no others. Every one-off breakpoint invented for a single component is invisible to the next person,
who then invents a fifth — which is how this panel ended up with 599, 719, 959, 1099 and 1279 in play at once.

| Step | Range | What changes |
| --- | --- | --- |
| **Compact** | `max-width: 599px` | Tables become stacked cards, actions take the full width and divide it evenly, dialogs dock to the bottom edge |
| **Medium** | `max-width: 839px` | Rows with a control and a decision on them stack: the access request, anything laid out as label-control-action |
| **Shell** | `max-width: 959px` | The navigation drawer stops holding a column and overlays with a scrim; touch targets grow; type in fields reaches 16px so iOS stops zooming |
| **Large** | `max-width: 1199px` | Columns that are worth reading but never worth the actions column scrolling away are dropped; the drawer defaults to its rail |

The shell step is 959 rather than 839 because it is where the drawer's column stops paying for itself, and it is
matched in JavaScript — `useMediaQuery("(max-width: 959px)")` — so the layout and the behaviour cannot disagree. Any
media query in the stylesheets must use one of these four numbers.

**The audit probes both sides of every step** (`web/tools/ui-audit`), because a rule that fires one pixel early is
invisible to a list of round numbers.

## Elevation & Depth

Surfaces are flat at rest: cards, tables and the app bar carry a hairline border, never a shadow. Depth is reserved for transient top-layer chrome only — the popover menu, the native `<dialog>`, the right-docked sheet and the snackbar each carry one of two shadow tokens. Buttons and switches use a small `shadow-1` only on hover/thumb, never at rest.

### Shadow Vocabulary
- **shadow-1** (`0 1px 2px 0 rgba(60,64,67,.3), 0 1px 3px 1px rgba(60,64,67,.15)`; dark uses black at higher opacity): filled-button hover, switch thumb.
- **shadow-3** (`0 1px 3px 0 rgba(60,64,67,.3), 0 4px 8px 3px rgba(60,64,67,.15)`; dark equivalent): menu popover, dialog, sheet, snackbar, and the mobile drawer only while it is open over the scrim.

### Named Rules
**The Flat-By-Default Rule.** Persistent surfaces (app bar, drawer, cards, tables, banners) are flat with a hairline border. Shadow appears only on menu, dialog, sheet and snackbar — surfaces that float over the page and disappear on dismiss.

## Shapes

Controls (buttons, fields, chips' pill, inline selects) use a 4px radius. Cards, banners, table-adjacent containers and the audience/recipient list use an 8px radius. Pills (chips, tab counts, scrollbar thumb) use a 999px full radius. Dialogs use 12px; the sheet is a right-docked full-height panel with 0 radius (edge-to-edge). Avatars, the mark, icon buttons and the empty-state icon well are circular.

## Components

### Buttons
- **Shape:** 4px radius, 36px height (32px `btn-small`, 44px on coarse pointers).
- **Filled:** Google Blue background, white text; hover darkens to `#1967d2` with `shadow-1`; pressed darkens further with no shadow.
- **Outlined:** hairline border, blue text, blue-tinted hover fill (`primary-state`).
- **Text:** no border, blue text, blue-tinted hover/active fill.
- **Danger / Danger-text:** same shapes, error red in place of blue.
- **Busy:** label goes transparent, a spinning `ProgressRing` centres over the button (`aria-busy`).

### Chips
- **Style:** pill (999px), hairline border, white surface by default.
- **Tonal/primary/success/warning/error:** borderless, filled with the matching container tone.
- **State:** toggle chips (`button.chip[aria-pressed="true"]`) switch to the primary-container fill.

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** surface white (surface `#2d2e31` dark), hairline border, no shadow.
- **Shadow Strategy:** none at rest — see Elevation & Depth.
- **Internal Padding:** header 16/20/12px, body 4/20/20px, footer 12/20px with a hairline top rule.

### Inputs / Fields
- **Style:** 40px min-height, hairline-strong border, 4px radius, white surface.
- **Focus:** border turns blue with an inset 1px blue ring (no glow/blur).
- **Disabled:** ink-disabled text, hairline border, transparent background.
- **Select:** native appearance removed, custom chevron SVG swapped per theme.

### Navigation
- **App bar (64px, 56px mobile):** menu button, mark (32px rounded-square, blue fill), title (Google Sans Flex 500/20px), divider, scope chip (outlined pill-like control naming the active game), spacer, theme toggle, avatar (40px circle).
- **Drawer (256px):** grouped nav items, 40px pill rows, active item gets `primary-container` fill and `on-primary-container` text; section labels are 12px/500 secondary ink; footer pinned to the bottom.
- **Icon rail (960–1279px):** same drawer, collapsed to 72px, items become 48px circles, labels/sections/footer hidden until pinned open.
- **Mobile drawer (<960px):** fixed modal panel sliding from the left over a scrim, `shadow-3` while open.
- **Tabs:** underline pattern — 48px row, secondary ink at rest, blue text plus a 3px blue underline bar when selected; a pill count badge follows the label.
- **Table:** 48px header and body rows, hairline rules, hover tint, row-actions column right-aligned and width-collapsed; below 600px width (container query) collapses to stacked label/value records per row with the action row last.

### Menu (popover)
Fixed-position popover with `::backdrop` transparent, 4px radius, `shadow-3`, 8px vertical padding, 40px-min-height items with a leading secondary-ink icon; entrance is a 180ms fade/scale-up from the anchor. Two triggers share it: the overflow icon button and the app-bar avatar.

### Dialog and Sheet
- **Dialog:** native `<dialog>`, 520px max width, 12px radius, `shadow-3`, scrim backdrop, 24px body padding, actions right-aligned.
- **Sheet:** native `<dialog>` docked to the right edge, full height, 480px max width, 0 radius, header/body/footer split with hairline rules, slides in from the right (24px translate, 180ms).

### Snackbar
Fixed bottom-left host (bottom-full-width on phones), dark-on-light-theme inverted surface (`--snack-bg`/`--snack-ink`), 48px min-height, `shadow-3`, one action in `--snack-action` blue-tint; success/error variants tint only the leading icon.

### Terminal (signature component)
A committed terminal grammar on the world Console tab: dark surface regardless of theme (`--term-bg`/`--term-ink`), header bar with an online/offline status dot, monospace output with muted/amber/blue line roles, a blinking block cursor, and an input row with quick-command chips. This is the one place the console departs from the light Material surface, by design, to read as a real shell.

### A header earns its place
A column heading is worth a line when the column would otherwise be ambiguous — `Status`, `Wipe`, `Stored`, `Size`.
It is noise above a column that says what it is: a person with an avatar, a select already showing `Owner`, a pair of
buttons. Those tables pass `hideHeader`, which keeps the row in the markup for anybody reading the table aloud and
stops it taking a line on screen.

The same test applies to a card's description. If it restates the columns beneath it, delete it; keep it only for a
fact that appears nowhere else — that nothing here is overwritten, that a pack link expires in an hour, that these
fields are read-only because an Owner manages them.

### Three kinds of nothing
A screen with nothing on it is saying one of three different things, and they must not look alike.

| The reader sees | It means | How it is drawn |
| --- | --- | --- |
| **Empty** | The feature works. There is nothing to show yet. | `EmptyState`, with the icon of the thing that is missing — a backup, a world, a role — and a sentence about what would put something here |
| **Waiting on a condition** | The feature works. Something has to happen first. | `EmptyState` with the same domain icon, plus the action that satisfies the condition where one exists |
| **Not connected** | The feature does not exist in this deployment yet. | `NotConnected`, which draws the closed sign `do_not_disturb_on` and offers no retry, because nothing the reader does today will make it answer |

An empty state wears **the icon of its own feature**, the same one the rail or the tab carries, so the screen still says
where you are when it has nothing to say: `public` for worlds, `inventory` for presets and releases, `backup` for
backups, `history` for wipes, `admin_panel_settings` for roles, `person_add` for access requests, `group` for players,
`link` for linked accounts, `sync` for operations.

Two icons are deliberately not the feature's, because they report something other than emptiness. `lock` says *your role
may not*. `do_not_disturb_on` says *this is not open yet*. Reaching for the wrong one tells somebody to go and ask for a
permission that would not help them — and giving a closed feature its own icon would blur it back into an empty one,
which is the distinction this section exists to draw.

`NotConnected` has two shapes, and the choice is about **how much is missing**, not about where it sits. The full
state — big sign, heading, sentence — is for a whole page or feature that is absent: there is nothing else to look at.
`inline` draws a strip, for a feature that works while one part of it does not: the links are all there and listed, only
adding and removing them is unbuilt. Using the full state for a missing part writes "nothing here" over something that
is plainly there.

Which of the three applies is not a judgement made in the screen. `unavailable` from the transport means not connected;
anything else that yields no rows is an empty state. See [ADR-0053](../docs/adr/0053-tell-not-built-apart-from-broken.md).

## Do's and Don'ts

### Do:
- **Do** pair every status with a Material filled icon and a label (`ok`, `progress`, `off`, `unknown`, `ready`, `error`, `warning`, `info`, `archived`, `absent`, `pending`) — never colour alone.
- **Do** draw unlit states (Archived, Not created, no address) as their own icon-and-label state, not an empty cell.
- **Do** tell "nothing yet" apart from "not built yet": an empty state carries the icon of what is missing, a closed feature carries `do_not_disturb_on`.
- **Do** keep the content pane unconstrained in width; it is a resource console, not a centred marketing column.
- **Do** reserve shadow for menu, dialog, sheet and snackbar; every other surface stays flat with a hairline border.
- **Do** use Google Sans Flex only for titles; Roboto for everything functional; Roboto Mono for anything precise or comparable.

### Don't:
- **Don't** use Google Blue as a background fill outside containers, selection and controls — it marks action and state, not decoration.
- **Don't** add a shadow to a persistent surface (card, table, app bar, drawer) to fake depth; use the hairline border and tonal fill instead.
- **Don't** cap the content pane's width; the 4K and wide-viewport case is a design target, not an overflow to hide.
- **Don't** introduce a kicker/eyebrow label, a hard-offset neobrutalist shadow, or a system display face; none exist in the build and none should be added.
