---
version: 1
slug: "src-screens-landingscreen-tsx"
primary_target: "src/screens/LandingScreen.tsx"
related_targets: ["src/components/TelegramLogin.tsx","src/styles/landing.css"]
---

# Surface brief: the Spawnpoint front door (landing for signed-out visitors)

Scope: the page at the panel's bare root (`#/`) for everyone, signed out or in, and the sign-in hand-off into the console. Mode: Persuade (the visitor decides to sign in). Inside the established world recorded in DESIGN.md; the only additions are a centred measure and a display step for the headline.

Audience and job: members of a private gaming group arriving from a Telegram link or a bookmark; occasionally a newcomer. They should understand in seconds what Spawnpoint does and continue: sign in from the app bar, or, already signed in, open the console from the avatar menu or the hero link. Owner's rulings during the build: no sign-in button in the body, no "how access works" or roles copy, no "three games" count (temporary), no configuration banner; the signed-in person sees their avatar top right like a social network.

Content and proof: the real facts only. One shared AWS host runs one session at a time; stopping saves the world, takes a verified backup and shuts the host down; games and worlds, backups, wipes and restores, builds from Git into immutable releases, client packs for the running release, Telegram invitations, and the console and metrics pages whose gateway and feed are still to land. A static product shot built from the console's own components with example data, labelled as such. No metrics, testimonials, prices or invented claims.

Constraints: the page renders for every auth state at `#/`; signed-out, unconfigured and sign-in-error states also land here from any hash (the bar button disables, with a title only, when the deployment lacks its OIDC client id); a sign-in started here ends in `#/worlds`; the Telegram Mini App path never sees it (initData signs in directly); the boot card covers loading on console hashes and the visitor-without-role card. Light and dark. Phone to 4K.

## Direction contract

THESIS: The landing is the console's own front door: it wears the console's app bar, carries sign-in and the signed-in avatar where social networks do, and shows the console itself as the proof, so the visitor sees the exact object they will get. It refuses the generic SaaS hero (gradient headline, three icon cards, logo strip, a second CTA in the body) and it refuses a marketing voice; the copy is the product's operational voice.

OWN-WORLD: DESIGN.md's Spawnpoint Console system, unchanged: white app bar over a Grey-50 canvas, hairline cards at 8 px, Google Blue only on the primary action and links, Google Sans Flex titles at 400, Roboto body, Roboto Mono for IDs and addresses, status glyph plus label. The one addition is measure: a centred 1120 px column with a larger display step (44 px desktop, 32 px phone) for the single headline.

STORY: A player reads the headline and the one-paragraph explanation, recognises the console in the shot, presses Sign in with Telegram in the app bar and lands in Worlds. A signed-in player sees their avatar top right and opens the console from its menu or the hero link. A newcomer signs in and, having no role yet, sees their avatar with Request access.

FIRST VIEWPORT: Desktop 1440: the console app bar (mark, Spawnpoint, theme toggle, and at the right either the filled Sign in with Telegram button or the signed-in avatar with its menu: Open the console, Profile, Sign out). Below, a two-column hero: left the headline (44 px), one paragraph, and a row of text links (Open the console when signed in; What the console does); right the product shot: a framed miniature console (bar strip, the session card "Minecraft online" with desired and observed, a two-row worlds table with status, name, release, address and Stop) captioned "Example data". Under the fold: "What the console does" as a labelled detail list of seven rows (games and worlds; one host on demand; backups, wipes and restores; builds from Git; client packs and mods; invitations in Telegram; console and metrics), then a one-line footer. Mobile 390: bar with the mark and the sign-in button or avatar, hero stacks with the shot below the copy, the list stacks.

FORM: Dealt structure 5 of the grounded list (the console's own front door), seed key 442de976; alternates dealt: 2 (three-step ritual with real screenshots) and 6 (FAQ-led page). Challengers all declined on both axes; raises: the registered-layer reveal (ukiyo-e: the shot's frame draws first and its rows register in one authored 400 ms moment, none under reduced motion); found-object honesty (Merz collage: the shot carries real fixture records, IDs and releases, never lorem); one pull (drawcord cape: a single primary action turns the flat page into the console); multiplane declined with no donation (parallax is refused on this surface).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Signature interaction: Sign in with Telegram (in the app bar) opens the Telegram OIDC popup; on success the same tab becomes the console, the hash moving to `#/worlds` with no page load. Motion grammar: the one authored moment is the shot's layered reveal on load; everything else inherits the console's 150 to 200 ms ease-out.

Unresolved: whether the footer should link the public repository (kept out until the owner confirms the repository is public).
