# Terminal skin: buttons, placement and consistency

An eyes-on pass over `skins/terminal` on the `feat/terminal-skin` branch at `e8b3363`, 2026-09-28. It complements
the mechanical run in [tools/ui-audit](../tools/ui-audit/README.md), which at fifteen widths in both themes found
nothing on this skin: no sideways scroll, no target under the floor, no contrast under 4.5, no silent truncation.
Everything below is about where a control sits and whether the same control looks the same twice, which no probe
measures.

The rules the skin is held to are its own, in [DESIGN.md → Terminal](../DESIGN.md#terminal): a verb is its word
between brackets, the verb that matters comes first, nothing floats to the far edge of a line, a value and its copy
key never break apart, a named panel's verbs sit in its rule.

## How it was done

- Demo mode (`?demo&latency=0&skin=terminal`), served by `npm --prefix web run dev` on `127.0.0.1:5173`.
- Eight screens and nine dialogs at 1440 and 1280 (desktop), 768 (tablet), 390 (phone, coarse pointer), plus 699/700
  for the rule step and 840 for the table step; light and dark.
- Every number below was read from the live DOM through Chrome DevTools (`getBoundingClientRect`, computed style).
  The raw measurements and the captures are in `web/.impeccable/review/terminal-skin-2026-09-28/`, which git ignores:
  `devtools-1280.json`, `devtools-390.json` and twenty-one PNGs named `<screen>-<width>.png`. Re-capture by opening
  the routes at those widths; nothing here depends on real data.

## Systemic findings

These repeat across screens. Fixing one instance fixes nothing; each needs a rule.

### 1. Three conventions for the order of verbs

| Where | Order | Source |
| --- | --- | --- |
| World page head | primary first: `[Stop] [Refresh] [Invite players] [⋮]` | [World.tsx:26](../src/skins/terminal/World.tsx#L26) |
| Worlds panel rule | primary last: `[Refresh] [Create world]` | [Worlds.tsx:41](../src/skins/terminal/Worlds.tsx#L41) |
| Confirmation, Hosting sheet, password form | cancel first: `[Cancel] [Stop session]`, `[Cancel] [Save settings]` | [Dialogs.tsx:48](../src/skins/terminal/Dialogs.tsx#L48), [Dialogs.tsx:128](../src/skins/terminal/Dialogs.tsx#L128), [Profile.tsx:160](../src/skins/terminal/Profile.tsx#L160) |
| Access requests row | primary last: `[Dismiss] [Approve]` | [Access.tsx:53](../src/skins/terminal/Access.tsx#L53) |

DESIGN.md says "the verb that matters first". On a phone the Worlds rule verbs step down and stack, so the primary
verb ends up on the third line of the panel (`worlds-390.png`, Refresh at y 863, Create world at y 915).

**Suggested rule:** primary first everywhere, including dialogs (`[Stop session] [Cancel]`), or primary last
everywhere and the sentence in DESIGN.md changed. One or the other.

### 2. Whether a key carries an icon is decided by the model, not the skin

`Verb` draws `action.icon` when the bones happen to supply one
([ui.tsx:86](../src/skins/terminal/ui.tsx#L86)). The result on screen:

| With an icon | Without |
| --- | --- |
| Refresh, Create world, Stop, Start, Invite players, Sign out, Open in browser, Restore, Download, Linked accounts, Send invitation, Add email and password, Reset, Run, How the first Owner is set | Approve, Dismiss, Revoke, Copy link, Create invitation, Change password, Send reset link, Resend verification, Cancel, Save settings, Backups (wipe row), Try again, Clear selection, Clear search, the quick commands |

So the same screen mixes them: the head says `[■ Stop]`, the confirmation of that action says `[Stop session]`;
Identities has `[⊙ Linked accounts]` and the panel above it `[Dismiss] [Approve]`; Create world's footer has
`[+ Create world]`, Hosting's has `[Cancel] [Save settings]`.

**Suggested rule:** the skin decides. Either `Verb` passes `hideIcon` by default and only icon-only keys
(`[⧉]`, `[⋮]`, `[×]`, theme) keep a glyph, or every action in the core gets an icon.

### 3. Five heights for the same bracketed key

| Key | 1280, mouse | 390, coarse | Where |
| --- | --- | --- | --- |
| bare (`> 4 permissions`) | 24 | 32 | [Access.tsx:204](../src/skins/terminal/Access.tsx#L204) |
| small | 32 | 40 | table rows, choices |
| medium | 36 | 44 | page heads, panel rules, `[⧉]` copy |
| field-height | 40 | 44 | `[Create invitation]`, `[Copy link]` ([terminal.css:1757](../src/skins/terminal/terminal.css#L1757), [terminal.css:1783](../src/skins/terminal/terminal.css#L1783)) |

Where it shows:

- One row of the Worlds table holds `[⧉]` at 36px and `[⋮]` at 32px, two pairs of brackets of different size side
  by side. `Copy` has no `size` prop ([ui.tsx:114](../src/skins/terminal/ui.tsx#L114)) while `Overflow` in the row
  is small ([Worlds.tsx:72](../src/skins/terminal/Worlds.tsx#L72)). Same in Backups: copy 36, Restore 32.
- Profile's accent row: well 40, input 40, `[Reset]` 36 ([Profile.tsx:89](../src/skins/terminal/Profile.tsx#L89)).
  The invite form solves the same problem by forcing the verb to 40. Two answers to one question.
- One profile page carries 36 (`[Sign out]`, `[Reset]`) and 32 (`[Change password]`). One Access page carries 40, 32
  and 36.

**Suggested rule:** two heights, medium and small, and a key beside a field is aligned with `align-items`, not
stretched to the field's height. `Copy` takes `size`; inside a table everything is small.

### 4. The same verb with a different weight

`Create world` is primary in the Worlds rule ([Worlds.tsx:42](../src/skins/terminal/Worlds.tsx#L42)) and plain
small in the Releases rows ([Releases.tsx:44](../src/skins/terminal/Releases.tsx#L44)). `Restore`, which opens a
new wipe, is plain. `Approve` is primary. Nothing says what earns the accent.

**Suggested rule:** primary marks the one verb a screen exists for (Create world on Worlds, Send on Invite, Approve
in a request row); the same verb reached from elsewhere is plain.

### 5. Row height depends on what the row holds

Rows at 1280: Roles 46, Release pointers 45, Presets 53, Wipes 53, Identities 53, Session events 53, Worlds 59,
Access requests 59, Backups 82. The CSS comment promises "rows of one height"
([terminal.css:1081](../src/skins/terminal/terminal.css#L1081)); the 36px copy key, the 32px select and the 24px bare
key each set their own.

**Suggested rule:** one control height inside tables (small), and a copy key that does not wrap (see 12).

### 6. Things that float to the right edge despite the "from the left" rule

- Delivery channel: `justify-content: space-between` pushes `[*] Telegram linked` to the panel's right edge
  ([terminal.css:1816](../src/skins/terminal/terminal.css#L1816)).
- A notice's retry verb: `margin-left: auto` ([terminal.css:933](../src/skins/terminal/terminal.css#L933)).
- The menu row's "observed" note: `margin-left: auto` ([terminal.css:257](../src/skins/terminal/terminal.css#L257)).
- Every list row: `.t-list-row > .t-stack { flex: 1 1 20ch }` pushes the state and the verbs to the right
  ([terminal.css:1374](../src/skins/terminal/terminal.css#L1374)): Sign-in methods, Recent invitations, Linked
  accounts (state right edge 903 = row right edge).
- The timestamp in an invitation history row (x 788–903 in a 560px drawer) and `peak` in a chart caption
  ([terminal.css:2005](../src/skins/terminal/terminal.css#L2005)).

Some of these are fine as rows (a row's verb column keeps its right edge by design). The rule in DESIGN.md
should list the exceptions, or the exceptions should go.

### 7. The rule slot holds things that are not verbs

`Panel`'s `verbs` prop is used for a State (`[*] Complete`, [Access.tsx:89](../src/skins/terminal/Access.tsx#L89)),
a status line ("Saved to your identity", [Access.tsx:275](../src/skins/terminal/Access.tsx#L275)) and a radio row
(the metrics window, [Metrics.tsx:49](../src/skins/terminal/Metrics.tsx#L49)). Under 700px all three step down as
if they were a verb row, with the verb row's 20px top padding, and become a stray line of text above the table
(`access-notifications` at 699, `metrics` at 699 and 390).

**Suggested rule:** the rule slot takes `Verb`s only; a state, a note or a filter goes into the panel head.

### 8. In a dialog the name and the close key stick out of the box

The panel name and the rule verbs paint the canvas colour over the rule
([terminal.css:349](../src/skins/terminal/terminal.css#L349), [terminal.css:383](../src/skins/terminal/terminal.css#L383)).
On a page that blends in. Over the scrim it does not: every dialog shows two pale tabs above its top edge. Measured
on Create world at 1280: panel top 155, name top 145, close key top 138 and bottom 174. On a phone the key is 44px,
so it overhangs by 21px (`world-create-390.png`, `world-invite-1280.png`).

**Suggested fix:** inside `.t-modal` and `.t-drawer` give the name and the close key the dialog's own surface, and
keep the rule under them, or draw the close key inside the box on the first line.

### 9. Dialogs close in three different ways

| Dialog | `[×]` in the rule | Cancel in the foot |
| --- | --- | --- |
| Hosting ([Dialogs.tsx:128](../src/skins/terminal/Dialogs.tsx#L128)) | yes | yes |
| Create world ([Dialogs.tsx:95](../src/skins/terminal/Dialogs.tsx#L95)), Invite ([Dialogs.tsx:152](../src/skins/terminal/Dialogs.tsx#L152)), Linked accounts, Role | yes | no |
| Confirmation ([Dialogs.tsx:48](../src/skins/terminal/Dialogs.tsx#L48)), Select a game | no ([ui.tsx:480](../src/skins/terminal/ui.tsx#L480), `Modal` draws none) | yes |

A drawer with no `data-autofocus` (Invite, Hosting, Linked accounts, Role) opens with focus on `[×]`, because it is
the first focusable element; the focus ring on the close key is the first thing seen (`world-invite-1280.png`).

**Suggested rule:** every drawer has `[×]` in the rule and a Cancel in the foot; every modal has Cancel; a drawer
focuses its first field or its primary verb.

### 10. The overflow menu is anchored to the trigger's right edge

[ui.tsx:399](../src/skins/terminal/ui.tsx#L399): `left = rect.right - width`. Right for a table's last column. In
the world head the trigger sits at x 515–567 and the menu opens at x 327–567, growing leftwards over `[Refresh]`
and `[Invite players]` (`world-menu-1280.png`); on a phone it opens at x 43 for a trigger at x 231.

**Suggested fix:** anchor to the trigger's left edge when it is in the left half of the viewport.

### 11. A radio, a switch and a boxed radio

`Choice` draws `(o)` / `( )`, `Toggle` draws `[x]` / `[ ]`. In B612 Mono the round and the square brackets are
nearly the same shape, so on screen a radio and a switch read alike. On top of that the Invite audience radio is a
bordered card ([terminal.css:1463](../src/skins/terminal/terminal.css#L1463)) while the same control in Profile,
Metrics and Backups is an inline glyph row. Three drawings of "one of several".

**Suggested rule:** one drawing for a radio, whether or not it has a description line; if the card is wanted, the
glyph row should become a card too, or the card should lose its border.

## Findings by screen

### Worlds

- Rule verbs `[Refresh] [Create world]`: primary last (1). Row: `[⧉]` 36px beside `[⋮]` 32px (3).
- Phone: the rule verbs stack one per line under the name, Refresh above Create world (`worlds-390.png`).
- The overflow of a row opens upwards when there is no room below, right-anchored; fine.

### World

- Head verbs are consistent with each other (all with icons, primary first). On a phone they wrap into two lines,
  `[Invite players] [⋮]` on the second (`world-390.png`); the `[⋮]` reads as a stray key.
- Backups at 1280 (`world-backups-1280.png`): the copy key wraps under the archive name (code y 534–554, key y
  558–594) and under the checksum (536–552, 556–592). `.t-inline` may wrap
  ([terminal.css:974](../src/skins/terminal/terminal.css#L974)); only `.t-detail-value` has `nowrap`
  ([terminal.css:1310](../src/skins/terminal/terminal.css#L1310)). DESIGN.md: "A value and its copy key are one unit
  that never breaks across lines". `176.0 MiB` breaks into two lines in the 110px Size column
  ([World.tsx:115](../src/skins/terminal/World.tsx#L115)). The row is 82px with three keys at three heights.
- Backups on a phone: the filter radios wrap 2+1; the copy key sits alone on a line under the archive name.
- Confirmation: the question is the panel name, 12px tracked uppercase. On a phone it is the only heading of the
  dialog and reads as a field label (`world-confirm-1280.png`). Debatable, but the console face gives the same
  question a 22px title.

### Releases

- `[+ Create world]` plain small here, primary medium on Worlds (4). Rows 53px against 45px in the next panel (5).

### Access, Users

- Two headless tables in a row, Access requests and Identities, share a 180px Role column
  ([Access.tsx:52](../src/skins/terminal/Access.tsx#L52), [Access.tsx:57](../src/skins/terminal/Access.tsx#L57)) but
  the selects sit at x 819 and x 845 because the verb columns are 260 and 234 wide. The same offset at 768.
- On a phone the headless table hides `data-label`
  ([terminal.css:1228](../src/skins/terminal/terminal.css#L1228)), so the role select stands under the name with
  no label at all.
- `[Create invitation]` is 40px and has no icon; every other primary verb on the branch has one (2, 3).
- Initial owner: a State in the rule slot (7).

### Access, Roles

- `> 4 permissions` is the only action in a table without brackets, 24px, primary, chevron before the word
  ([Access.tsx:204](../src/skins/terminal/Access.tsx#L204)).
- In the role drawer the permission ids come out as `ACCESS.INVITE`: the `dt` rule uppercases them
  ([terminal.css:110](../src/skins/terminal/terminal.css#L110)). Elsewhere ids are lowercase `code`.

### Access, Notifications

- "Saved to your identity" in the rule slot (7); on a phone it becomes a line above the table.
- The two Game invitations toggles are 1198px wide buttons; hover underlines the word wherever the pointer is.
- Delivery channel floats its state to the right edge (6).

### Profile

- Theme radios carry icons, Look radios do not ([Profile.tsx:70](../src/skins/terminal/Profile.tsx#L70),
  [Profile.tsx:76](../src/skins/terminal/Profile.tsx#L76)).
- `[Reset]` 36px beside 40px fields (3). On a phone the theme radios wrap 2+1, `[Reset]` drops under the fields,
  and the two password verbs stack one under the other in the list row (`profile-390.png`).
- Sign-in rows push the state and the verbs to the right (6).

### Metrics

- The window radios live in the rule slot (7); in Profile the same control sits under a label, in Backups in a
  filter row. Three homes.

### Console, Boot, top bar, menu row

- Nothing to report. The bar's avatar is the one unbracketed control in the frame, which reads as intended.

## What holds

The top bar and the menu row at every width, the host scene, tabs, the details list at its 480px step, the 700px
step for the rule (the name and the verbs never meet), the 840px table step, the dark theme, focus rings, and
everything the mechanical audit measures.

## Suggested order

1. One order of verbs and one rule for icons (1, 2). Both are a few lines in `ui.tsx` and the screens.
2. `Copy` takes `size`; small inside tables; drop the 24 and 40px heights and align keys beside fields (3, 5).
3. `nowrap` on value-plus-copy in tables and a 130px Size column (Backups).
4. The rule slot for `Verb`s only (7).
5. Dialogs: the name and close key over the scrim, Cancel in every drawer, focus on the first field (8, 9).
6. Overflow anchoring (10).
7. One drawing for a radio (11), then the list of right-edge exceptions in DESIGN.md (6).

Not covered: hover and active states, keyboard navigation beyond the focus on open, the real API instead of demo
data, and the sign-in screens, which are outside the skin.

## Follow-up, 2026-09-28

Fixed on the branch the same day, in the order above, and measured again through DevTools (`devtools-1280-after.json`,
`after-*.png` beside it). The rules the fixes settled on are written into [DESIGN.md → Terminal](../DESIGN.md#terminal).
The mechanical audit, run again afterwards at fifteen widths in the light theme, still finds nothing; the type check
and the 61 tests, the skin contract among them, pass.

| # | What changed | Measured after |
| --- | --- | --- |
| 1 | Primary first everywhere: Worlds rule `[Create world] [Refresh]`, confirmation `[Stop session] [Cancel]`, Hosting `[Save settings] [Cancel]`, password form and Access requests likewise. In a question focus rests on Cancel. | Confirmation opens with focus on `cancel`; Worlds rule verbs fit one line on a phone (both at y 863) |
| 2 | `Verb` and `Key` draw no icon; `Choice` lost its icon prop; the theme radios, Reset, Run and the Owner disclosure lost theirs. Only icon-only keys keep a glyph. | Zero `svg` inside any `.t-verb` that is not icon-only, on every screen |
| 3 | `Copy`, `Address` and `IconKey` take `size`; small inside tables. The bare 24px key and the 40px field-height keys are gone; `[Create invitation]` and `[Copy link]` are 36px centred on their field. | Worlds row: `[⧉]` 32 beside `[⋮]` 32; Roles `[4 permissions]` 32; invite verb 36 on a 40 field |
| 4 | `Create world` stays primary where it is the point of the screen and plain in Releases; recorded as the rule. | unchanged by design |
| 5 | Every cell is `calc(--t-key-small + 20px)` tall, so a table of words and a table of keys agree. | Roles 53, Identities 53, Wipes 53, Backups 53, Presets 53, Pointers 52; Worlds and Access requests 59 because of their two-line stacks |
| 6 | The right-edge exceptions are now listed in DESIGN.md; nothing else keeps a right edge. | — |
| 7 | `Panel` gained `head`; the Owner state, the "Saved to your identity" note and the metrics window moved there. `verbs` is documented as keys only. | No `.t-panel-rule-verbs` on Access users, Notifications or Metrics |
| 8 | Dialogs keep their title on the first line inside the box, the close key at its end (`t-dialog-head`); nothing straddles the rule. | Create world at 1280: panel top 127, title 146, close key 136–172, all inside |
| 9 | Every drawer has `[×]` and a foot verb: Cancel for a form, Close for a reading (`Drawer` gained `cancel`). Focus goes to the first field (`data-autofocus` on the Hosting select and the Invite audience), else parks on the body. | Hosting focus on `select`; Linked accounts and Role focus on the body; Invite on the radio |
| 10 | The overflow list hangs from the key's left edge when the key is in the left half of the screen. | World head: key x 439, menu x 439 |
| 11 | The Invite audience radios are the same mark and word as a choice row, small print beneath, a hairline between; the card border is gone. | First radio border 0, second border-top 1px |
| Backups | `.t-with-copy` keeps a value and its key on one line; Size 130px, Stored 170px, Archive 36%; a stamp inside a table never wraps. | Rows 53 (were 82); all three keys at y 534 |
| Access, Users | Both tables carry a 260px verb column, and a column's width sits on the cell as well as the head, because a headless head is out of the flow. | Both role selects at x 819 (were 819 and 845) |
| Access, Roles | Permission ids keep their case in the role drawer (`t-details-code`). | `text-transform: none` |

Deviations from the text above: the Cancel a drawer's foot draws runs the model's close action under the skin's own
word (the action's label, "Close panel", stays on the `[×]`); dialogs took the second option in 8, the title inside the
box, rather than repainting the tabs.

Left as found, on purpose or for later: the two full-width toggles in Game invitations; the unlabeled role select in
a headless record on a phone; the 12px question in a confirmation; the world head wrapping to two lines on a phone;
`[Reset]` dropping under the accent fields on a phone; the Delivery channel state at the right, now listed as a
list-row exception.
