import { Access } from "../console/Access";
import { ConfirmationDialog, CreateWorldSheet, InvitationSheet, ScopeDialog, WorldSettingsSheet } from "../console/Dialogs";
import { Profile } from "../console/Profile";
import { Rcon } from "../console/Rcon";
import { Releases } from "../console/Releases";
import { World } from "../console/World";
import type { Skin } from "../skin";
import { Metrics } from "./Metrics";
import { Boot } from "./Boot";
import { Shell } from "./Shell";
import { Worlds } from "./Worlds";

// The terminal: one monospace grid, every state a mark and a word, the host
// drawn in glyphs. It owns the frame, the first screen and the metrics
// strip; the other pages are the console skin's views redrawn by this
// skin's stylesheet, which applies while its Shell is mounted (terminal.css,
// imported in main.tsx).
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
