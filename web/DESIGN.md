---
name: Spawnpoint
description: A calm operations console for disposable private game infrastructure.
colors:
  primary: "#0b57d0"
  primary-hover: "#0847ad"
  canvas: "#f6f8fc"
  navigation: "#f0f3f9"
  surface: "#ffffff"
  surface-muted: "#f8fafd"
  border: "#d5dbe5"
  text: "#1f2633"
  text-secondary: "#5b6575"
  success: "#137333"
  warning: "#8a4f00"
  danger: "#b3261e"
  terminal-bg: "#11161d"
  terminal-header: "#171d26"
  terminal-border: "#364050"
  terminal-text: "#e6edf7"
  terminal-muted: "#96a2b3"
  terminal-accent: "#8ab4f8"
  terminal-live: "#aeb9c8"
  terminal-button: "#a8c7fa"
typography:
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(28px, 1.7vw, 40px)"
    fontWeight: 560
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(18px, 1vw, 24px)"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(14px, 0.8vw, 18px)"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(12px, 0.7vw, 15px)"
    fontWeight: 650
    lineHeight: 1.4
  console:
    fontFamily: "Cascadia Code, JetBrains Mono, ui-monospace, monospace"
    fontSize: "clamp(13px, 0.8vw, 16px)"
    fontWeight: 400
    lineHeight: 1.7
rounded:
  control: "8px"
  surface: "12px"
  control-large: "10px"
  surface-large: "14px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "20px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "0 15px"
    height: "42px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.surface}"
  surface:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.surface}"
    padding: "20px"
  status-chip:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.pill}"
    height: "28px"
---

# Design System: Spawnpoint

## Overview

**Creative North Star: "The Quiet Control Room"**

Spawnpoint is a restrained cloud operations workspace for a small gaming group. It borrows the legibility and information density of Google Cloud without copying its chrome: cool neutral planes, one cobalt action color, explicit state language, and continuous work areas instead of a dashboard of decorative cards.

The same hierarchy must hold inside Telegram, a normal browser, and a 4K desktop. Operational truth wins over spectacle: unavailable integrations render honest empty states, destructive operations are visually distinct, and permissions determine which navigation and actions exist.

**Key Characteristics:**

- Cool, low-chroma light and dark themes.
- Cobalt reserved for navigation, links, focus, and primary actions.
- Hairline divisions and tonal layering before shadow.
- Compact desktop density with 44 px touch targets on coarse pointers.
- Responsive composition that preserves reading order.

## Colors

The palette is cool and operational. Dark mode maps the same semantic roles to `#11151b` canvas, `#171c24` navigation, `#1c222c` surface, `#343d4a` border, `#e8edf5` text, and `#a8c7fa` accent.

### Primary

- **Control Cobalt** (`#0b57d0`): primary actions, active navigation, links, selection, and focus.
- **Control Cobalt Hover** (`#0847ad`): interactive hover only.

### Neutral

- **Cool Canvas** (`#f6f8fc`): application field.
- **Navigation Mist** (`#f0f3f9`): persistent navigation plane.
- **Operational White** (`#ffffff`): surfaces and fields.
- **Hairline Grey** (`#d5dbe5`): borders and structural division.
- **Ink** (`#1f2633`): primary text.
- **Slate** (`#5b6575`): supporting text.

### Named Rules

**The One Accent Rule.** Cobalt carries interaction, not decoration; status colors carry only status.

**The Semantic Pair Rule.** Every light token has a dark semantic counterpart in `src/design-system.css`; screens never hardcode theme-specific product colors.

## Typography

**Display Font:** Inter with the platform UI sans-serif stack

**Body Font:** Inter with the platform UI sans-serif stack

**Console Font:** Cascadia Code with JetBrains Mono and platform monospace fallbacks

**Character:** neutral, compact, and tool-like. Hierarchy comes from size, weight, and whitespace rather than multiple typefaces or all-caps decoration.

### Hierarchy

- **Headline** (560, 28–40 px, 1.15): one page title per screen.
- **Title** (600, 18–24 px): section and service-state headings.
- **Body** (400, 14–18 px, 1.5): descriptions and operational detail, generally capped near 72ch.
- **Label** (650, 12–15 px): controls, table headers, badges, and metadata.
- **Console** (400, 13–16 px, 1.7): RCON output and command entry only.

### Named Rules

**The Single Headline Rule.** A screen has one `h1`; surfaces use `h2` and rows use labels, never decorative overlines.

## Layout

The application uses a persistent navigation rail and a sticky context bar. Content fills the remaining workspace up to 1720 px, grows to 2050 px from 1600 px, and to 3000 px from 2400 px. Page gutters use `clamp(20px, 2.4vw, 44px)` and become 64 px on 4K-class screens.

At 820 px the rail becomes a fixed bottom navigation. The mobile context bar becomes a two-row grid: identity and state first, game/world breadcrumbs second. Container queries collapse split panels at 920 px, four-part key-value strips at 760 px, and semantic tables into labelled record cards at 540 px.

Hash routes preserve screen and Access tab across reloads. Layout changes may stack content but must not change its reading order.

## Elevation & Depth

Surfaces are flat at rest and separated by tonal contrast plus 1 px borders. The single ambient shadow (`0 10px 28px rgb(31 38 51 / 9%)`, darker in dark mode) is reserved for floating picker menus, authentication, and the invitation composer.

**The Flat-by-Default Rule.** Persistent cards never float; only temporary or modal-adjacent layers receive shadow.

## Shapes

Controls use an 8 px radius, containers use 12 px, and status/avatar shapes use full pills or circles. At 4K density those radii scale to 10 px and 14 px with the controls. Corners remain quiet; no nested stack of rounded cards is allowed. Hairline borders define sections inside a surface.

## Components

### Buttons

- **Shape:** 8 px radius; 42 px default height and at least 44 px for coarse pointers.
- **Primary:** cobalt background, on-accent text, 15 px horizontal padding.
- **Secondary/Ghost:** border or transparent treatment with cobalt text.
- **Danger:** semantic red, used for destructive confirmation only.
- **States:** shared loading spinner, disabled opacity, 150 ms color transition, visible `:focus-visible` ring.

### Status chips

Status is a 28 px pill with a dot and a textual label. Neutral, info, success, warning, and danger tones share one geometry.

### Cards / Containers

`Surface` owns the 1 px border, surface fill, and 12 px radius. `PageHeader` and `SectionHeader` own heading rhythm. `EmptyState`, `Notice`, and `RetryState` own non-happy paths without fabricated content.

### Inputs / Fields

Fields use surface fill, a strong neutral border, 8 px radius, and the shared focus ring. On phone widths they render at 16 px to prevent browser zoom.

### Tables

`DataTable` remains a real semantic table on wide layouts and becomes labelled record cards inside narrow containers. Screens provide columns and rendering; they do not create table-like `div` grids.

### Navigation

The rail is text-forward with one consistent SVG icon family. Active items use a cobalt-tinted fill and cobalt text. Mobile uses the same permission-filtered destinations in a fixed bottom bar.

## Do's and Don'ts

### Do:

- **Do** use shared UI primitives from `src/components/ui` for every new screen.
- **Do** expose loading, error, empty, disabled, pending, and success states.
- **Do** keep actions beside the state or object they affect.
- **Do** verify both themes and 390 px, desktop, and 3840 px widths.

### Don't:

- **Don't** render invented metrics, backups, releases, or activity.
- **Don't** introduce raw product colors or one-off button and table styles in screens.
- **Don't** use emoji, glyph characters, decorative overlines, gradients, or oversized marketing typography.
- **Don't** rearrange information on wide screens merely to fill space; enlarge the established fields and preserve reading order.
