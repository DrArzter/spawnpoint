import type { ComponentType, ReactNode } from "react";

import type { SnackbarQueue } from "../components/ui/Snackbar";
import type { AccessModel, BootModel, ConfirmationModel, CreateWorldModel, GameSettingsModel, InvitationModel, ProfileModel, ReleasesModel, ScopeModel, ShellModel, WorldModel, WorldsModel, WorldSettingsModel } from "../core/models";

/**
 * A skin is every face the console can wear, as one set of views. The bones
 * build the models and choose the page; the skin draws them. Two rules bind
 * a skin, and the contract test checks both: every action in a model reaches
 * the screen as a control carrying `data-action` with the action's id, and no
 * view reaches past its model into the API.
 */
export type Skin = Readonly<{
  id: SkinId;
  name: string;
  /** The frame: bars, navigation, the page slot, and the mounts for dialogs. */
  Shell: ComponentType<{ model: ShellModel; children: ReactNode }>;
  Boot: ComponentType<{ model: BootModel }>;
  Worlds: ComponentType<{ model: WorldsModel }>;
  /** A world, with its own console and its host's metrics as tabs (ADR-0062). */
  World: ComponentType<{ model: WorldModel }>;
  Releases: ComponentType<{ model: ReleasesModel }>;
  Access: ComponentType<{ model: AccessModel }>;
  Profile: ComponentType<{ model: ProfileModel }>;
  ScopeDialog: ComponentType<{ model: ScopeModel }>;
  ConfirmationDialog: ComponentType<{ model: ConfirmationModel | null }>;
  CreateWorldSheet: ComponentType<{ model: CreateWorldModel }>;
  WorldSettingsSheet: ComponentType<{ model: WorldSettingsModel }>;
  GameSettingsSheet: ComponentType<{ model: GameSettingsModel }>;
  InvitationSheet: ComponentType<{ model: InvitationModel }>;
  /** The shell draws the one Refresh (`ShellModel.refreshAction`); a page draws its own `refresh` only as a retry. */
  shellRefresh?: boolean;
  /** A skin that draws the notification queue itself; the default host is drawn when absent. */
  renderSnackbar?: (queue: SnackbarQueue) => ReactNode;
}>;

export type SkinId = "console" | "terminal";

/** Every face there is code for, in the order the registry knows them. */
export const SKIN_IDS: readonly SkinId[] = ["console", "terminal"];
export const DEFAULT_SKIN: SkinId = "console";

/**
 * The faces switched on (ADR-0106). A face left out keeps its code, which
 * still typechecks and builds, but it is never worn or offered, and no test
 * or UI gate checks it. `VITE_ENABLED_SKINS` (comma-separated) replaces the
 * list at build time. The default face must be on.
 */
const SWITCHED_ON: readonly SkinId[] = ["console"];

/** The faces a list names, checked: each one known, none twice, the default among them. */
export function enabledSkins(override?: string): readonly SkinId[] {
  const names = override?.trim() ? override.split(",").map((name) => name.trim()).filter(Boolean) : SWITCHED_ON;
  for (const name of names) {
    if (!(SKIN_IDS as readonly string[]).includes(name)) throw new Error(`Unknown skin "${name}" in the enabled skins`);
  }
  if (!names.includes(DEFAULT_SKIN)) throw new Error(`The default skin "${DEFAULT_SKIN}" must be enabled`);
  return SKIN_IDS.filter((id) => names.includes(id));
}

// `?.`: the UI gate and the Vite config read this module outside Vite, where import.meta.env is absent.
export const ENABLED_SKIN_IDS: readonly SkinId[] = enabledSkins(import.meta.env?.VITE_ENABLED_SKINS);
/** The faces a person may choose on the profile page. */
export const CHOOSABLE_SKIN_IDS: readonly SkinId[] = ENABLED_SKIN_IDS;
