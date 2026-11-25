# ADR-0098 — The console speaks from one message catalogue

- Status: Accepted — implemented
- Date: 2026-11-25
- Milestone: M6
- Relates: [ADR-0059](0059-separate-the-console-into-bones-and-skins.md)

## Context

The owner asked for one registry of the console's words, with translations. A survey of `web/src` (the demo and the
icons left out) found about 2,060 string literals that a person reads, and about 1,360 different texts:

| Where | Sites |
| --- | --- |
| The bones: `core/` models, builders, statuses, snackbar texts, form errors | about 610 |
| The console skin, `skins/console/` | about 690 |
| The terminal skin, `skins/terminal/` | about 450 |
| The front door: `screens/`, `components/`, `lib/signin.ts` | about 200 |
| The API adapters' failure texts (`api/live/`) and the error-code texts (`api/error-text.ts`) | about 350 |

Shapes: 1,850 plain texts, 210 texts with values put into them, 15 that depend on a count (`player` or `players`,
built with `=== 1 ?` or `plural()`), and 27 sentences that wrap markup (a strong word, a timestamp). The same intent
was often written twice: each skin had its own "Copy it now" sentence and its own invitation states. The API already
answers with error codes; the web turned each code into English in `api/error-text.ts`.

## Decision

- **One catalogue, typed by English.** `web/src/i18n/en.ts` holds every message by a stable id, `area.name`
  (`world.startNewWipe`, `error.last_owner`, `common.cancel`). Its type defines `MessageId`. A text used in more than
  one area lives under `common.`; an error code's text is `error.<code>`.
- **One file per locale.** `ru.ts` is typed `Catalogue`: every id of English with a message of the same shape. Russian
  is the second language.
- **Placeholders and plurals.** A value is a name in braces, `{worldDisplayName}`, and the compiler checks that a call
  gives each one. A message that depends on a count is an object of plural forms, selected by `Intl.PluralRules`
  (`one`, `other` in English; `one`, `few`, `many`, `other` in Russian), and its call gives `count`.
- **How code reads it.** `t(id, params)` returns text; `rich(id, nodes)` returns a fragment whose placeholders hold
  elements, for a sentence that wraps markup. The bones and both skins call the same function; a skin adds no words
  of its own. An Action's label and hint, a status label and a notice are built in core with `t()` and drawn as
  they are.
- **Codes stay codes.** The API returns codes; the web translates them by code. Nothing in the Lambdas changes.
  Text the API carries as data (world, role and game names, the manifest's setting labels, the demo's records) is not
  copy and is not translated here.
- **How the locale is chosen.** `?lang=` in the address, remembered; else the remembered choice; else the first of the
  browser's languages the catalogue has; else English. The profile page offers the choice in both skins, beside the
  look. Like the look (ADR-0059), the choice is per browser and a change reloads the page, so a locale is fixed for the
  life of the page. Dates and numbers use the locale's `Intl` tag.
- **Only the chosen catalogue is fetched.** English ships with the page. `src/entry.ts` fetches another locale's file
  before it imports `main.tsx`, so a message read when a module is evaluated is already in that language.
- **The test is the contract.** `web/test/messages.test.ts` fails when a locale misses or adds an id, when a message
  loses or gains a placeholder, when a plural lacks a form its language selects, when an id is not used, when a view
  or model carries a literal text (JSX text, a text attribute, a `label`/`hint`/`title`-like property), and when code
  compares or keys on an English message.
- **The UI gate runs both languages.** Russian words are longer. `tools/ui-audit` runs every page, width and state in
  English and in Russian (`LOCALE=en` narrows it); a state's selector that names words reads them from the catalogue.

## Consequences

**Good**

- Every word a person reads in the console is in one place, by one id, and a second language is one file.
- Same intent, same id: one key per meaning, used by both skins.
- A missing translation, a broken placeholder or a stray literal fails `npm test`, not a review.

**Bad, or risky**

- A message read at module scope keeps the language the page started in. This is correct only because a change of
  language reloads the page.
- The ids came from a migration and some carry the shape of their first English text. They are stable ids, not
  descriptions; renaming one is a code change.
- A few sentences are built from a translated fragment (`Your role cannot {verb}`). Russian reads well with an
  infinitive fragment, but a third language may need whole sentences.
- The UI gate takes twice as long.

**Mitigations**

- The guard test forbids literals in views and models, so the catalogue does not drift back into the code.
- A new fragment message is reviewed as a sentence in every locale before it lands.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| i18next, react-intl or FormatJS | The survey found plain text, named placeholders and count plurals only. `Intl.PluralRules` covers the plurals, and a typed object gives compile-time ids and placeholder checks that these libraries need a code generator for. No dependency, no runtime parser |
| ICU MessageFormat strings | Select and nested plurals are not needed; a parser would ship for features no message uses |
| Translate in the Lambda by `Accept-Language` | The API answers with codes already; words belong to the surface that shows them, and the bot and MCP have their own |
| Switch language without a reload | Every model and every module-level text would have to rebuild on a change; the look already reloads, and a language is chosen rarely |
| One catalogue per skin | The same intent would get two keys, the duplication this decision removes |
