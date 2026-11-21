import type { Skin } from "../skin";
import { Access } from "./Access";
import { Boot } from "./Boot";
import { ConfirmationDialog, CreateWorldSheet, GameSettingsSheet, InvitationSheet, WorldSettingsSheet } from "./Dialogs";
import { Profile } from "./Profile";
import { Releases } from "./Releases";
import { ScopeDialog } from "./Scope";
import { Shell } from "./Shell";
import { World } from "./World";
import { Worlds } from "./Worlds";

// The cloud console (C+A): an AWS-console grammar on a content grid, without
// its brand. Every view and primitive is the face's own (ui/, styles/); the
// console's components and stylesheet play no part in it. Reached with
// ?skin=cloud until it replaces the console face.
export const cloudSkin: Skin = {
  id: "cloud",
  name: "Cloud",
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
  shellRefresh: true,
  // The shell's flashbar draws the queue (useSnackbarQueue), so the default host is not drawn.
  renderSnackbar: () => null,
};
