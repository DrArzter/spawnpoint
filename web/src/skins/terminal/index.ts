import type { Skin } from "../skin";
import { Access } from "./Access";
import { Boot } from "./Boot";
import { ConfirmationDialog, CreateWorldSheet, InvitationSheet, ScopeDialog, WorldSettingsSheet } from "./Dialogs";
import { Metrics } from "./Metrics";
import { Profile } from "./Profile";
import { Rcon } from "./Rcon";
import { Releases } from "./Releases";
import { Shell } from "./Shell";
import { World } from "./World";
import { Worlds } from "./Worlds";

// The terminal: one monospace grid, every state a mark and a word, every verb
// its word between brackets, every panel a box with its name on the rule,
// the host drawn in glyphs. Every view is the face's own (ui.tsx); the
// console's components and stylesheet play no part in it.
export const terminalSkin: Skin = {
  id: "terminal",
  name: "Terminal",
  Shell,
  Boot,
  Worlds,
  World,
  Metrics,
  Console: Rcon,
  Releases,
  Access,
  Profile,
  ScopeDialog,
  ConfirmationDialog,
  CreateWorldSheet,
  WorldSettingsSheet,
  InvitationSheet,
};
