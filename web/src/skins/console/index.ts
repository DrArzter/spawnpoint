import type { Skin } from "../skin";
import { Access } from "./Access";
import { ConfirmationDialog, CreateWorldSheet, InvitationSheet, ScopeDialog, WorldSettingsSheet } from "./Dialogs";
import { Profile } from "./Profile";
import { Releases } from "./Releases";
import { Boot, Shell } from "./Shell";
import { World } from "./World";
import { Worlds } from "./Worlds";

// The Cloud console skin: the look the panel shipped with, now one face
// among possible others. Its stylesheets load with the skin, in main.tsx.
export const consoleSkin: Skin = {
  id: "console",
  name: "Cloud console",
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
  InvitationSheet,
};
