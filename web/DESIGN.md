# Spawnpoint UI system

Spawnpoint uses a quiet, operational control-panel language inspired by Google Cloud: neutral surfaces, a single blue accent, compact information density, and explicit system states. The interface must work both as a Telegram Mini App and in a normal browser tab.

## Foundations

- Use the semantic tokens in `src/design-system.css`; screen components must not introduce raw product colors.
- Default controls are 40 px high. On coarse pointers they grow to at least 44 px.
- Page content uses the shared shell width and responds to its container, not only to the browser viewport.
- Body copy must remain at least 13 px; 11–12 px is reserved for metadata and table labels.
- Every interactive element needs a visible `:focus-visible` state.

## Components

- `Button` owns button variants, sizes, loading/disabled semantics, and focus treatment.
- `Tabs` owns `tablist`, keyboard navigation, selection, and the active indicator.
- `DataTable` is a real semantic table on wide layouts and becomes labelled record cards in narrow containers.
- Native fields and selects share the same border, radius, focus ring, and disabled state.

## Responsive behavior

- At 820 px and below, the sidebar becomes a fixed bottom navigation and the compact top bar remains visible.
- Dense tables collapse into per-record cards based on their content container.
- Profile, role editing, and action clusters stack before their content becomes cramped.

## Product truthfulness

- A disabled control must explain why it is unavailable.
- Empty and disconnected telemetry must never render simulated data.
- Loading, error, empty, disabled, and success states are part of a feature, not follow-up polish.
