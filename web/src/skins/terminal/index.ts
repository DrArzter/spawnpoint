import type { Skin } from "../skin";
import { Access } from "./Access";
import { Boot } from "./Boot";
import { ConfirmationDialog, CreateWorldSheet, GameSettingsSheet, InvitationSheet, ScopeDialog, WorldSettingsSheet } from "./Dialogs";
import { Profile } from "./Profile";
import { Releases } from "./Releases";
import { Shell } from "./Shell";
import { World } from "./World";
import { Worlds } from "./Worlds";
import { t } from "../../i18n";

// The terminal: one monospace grid, every state a mark and a word, every verb
// its word between brackets, every panel a box with its name on the rule,
// the host drawn in glyphs. Every view is the face's own (ui.tsx); the
// console's components and stylesheet play no part in it.
export const terminalSkin: Skin = {
  id: "terminal",
  name: t("shell.terminal"),
  Shell,
  Boot,
  Worlds,
  World,
  Releases,
  Access,
  Profile,
  ScopeDialog,
  ConfirmationDialog,
  CreateWorldSheet,
  WorldSettingsSheet,
  GameSettingsSheet,
  InvitationSheet,
};
