import { DemoState, initialState } from "./data";

// `?demo&fixture=stress`: the demo at the form limits, for the UI gate. Names
// run to the 80 characters the world form allows, with and without spaces,
// and lists carry more rows than a screen shows. Ids stay, so every route works.

const SPACED = "Autumn season industrial survival world with a long shared name for all players";
const UNBROKEN = "Autumnseasonindustrialsurvivalworldwithalongsharednamethatneverbreaksanywhere";

/** A name of exactly `length` characters from `source`, repeated as needed. */
export function stretch(source: string, length = 80): string {
  return source.repeat(Math.ceil(length / source.length)).slice(0, length);
}

type Game = DemoState["snapshot"]["games"][number];

/** Long names on the Minecraft worlds and presets, plus a dozen extra worlds to overflow the list. */
function crowdMinecraft(minecraft: Game): void {
  const [rostik, vanilla] = minecraft.worlds;
  rostik.displayName = stretch(SPACED);
  vanilla.displayName = stretch(UNBROKEN);
  for (const preset of minecraft.presets) preset.displayName = stretch(`${preset.displayName} preset with a long descriptive name `);
  for (let index = 1; index <= 12; index += 1) {
    minecraft.worlds.push({
      ...vanilla,
      id: `minecraft-stress-${index}`,
      displayName: stretch(index % 2 ? SPACED : UNBROKEN, 20 + index * 5),
      materialization: index % 4 === 0 ? "archived" : "existing",
    });
  }
}

/** Long names on the people lists. */
function crowdPeople(state: DemoState): void {
  for (const identity of state.identities) identity.displayName = stretch(`${identity.displayName} `, identity.roleId === "player" ? 80 : 40);
  for (const candidate of state.candidates) candidate.displayName = stretch(`${candidate.displayName}`, 80);
}

/** Long whitelists, console lines and config file paths. */
function crowdRecords(state: DemoState): void {
  for (const edits of Object.values(state.configEdits)) edits[`config/${"a-very-long-folder-name/".repeat(4)}added-by-the-world.toml`] = { text: "a = 1\n", base: null, updatedAt: "2026-11-20T19:05:00.000Z", updatedBy: "DrArzter" };
  for (const list of Object.values(state.whitelists)) list.names = Array.from({ length: 24 }, (_, index) => `Player_${String(index).padStart(2, "0")}_long_name`.slice(0, 16));
  for (const [key, entries] of Object.entries(state.console)) state.console[key] = entries.map((entry) => ({ ...entry, output: stretch(`${entry.output} `, 240) }));
}

export function stressState(): DemoState {
  const state = initialState();
  const games = state.snapshot.games;
  const minecraft = games.find((game) => game.id === "minecraft")!;
  crowdMinecraft(minecraft);
  for (const game of games) {
    for (const world of game.worlds) if (game !== minecraft) world.displayName = stretch(`${world.displayName} `, 80);
  }
  crowdPeople(state);
  crowdRecords(state);
  return state;
}
