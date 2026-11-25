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
import { t } from "../../i18n";

// The console face (C+A, ADR-0072): an AWS-console grammar on a content grid,
// without its brand. Every view and primitive is the face's own (ui/, styles/).
export const consoleSkin: Skin = {
  id: "console",
  name: t("shell.cloudConsole"),
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
