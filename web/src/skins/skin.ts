import type { ComponentType, ReactNode } from "react";

import type { AccessModel, BootModel, ConfirmationModel, ConsoleModel, CreateWorldModel, InvitationModel, MetricsModel, ProfileModel, ReleasesModel, ScopeModel, ShellModel, WorldModel, WorldsModel, WorldSettingsModel } from "../core/models";

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
  World: ComponentType<{ model: WorldModel }>;
  Metrics: ComponentType<{ model: MetricsModel }>;
  Console: ComponentType<{ model: ConsoleModel }>;
  Releases: ComponentType<{ model: ReleasesModel }>;
  Access: ComponentType<{ model: AccessModel }>;
  Profile: ComponentType<{ model: ProfileModel }>;
  ScopeDialog: ComponentType<{ model: ScopeModel }>;
  ConfirmationDialog: ComponentType<{ model: ConfirmationModel | null }>;
  CreateWorldSheet: ComponentType<{ model: CreateWorldModel }>;
  WorldSettingsSheet: ComponentType<{ model: WorldSettingsModel }>;
  InvitationSheet: ComponentType<{ model: InvitationModel }>;
}>;

export type SkinId = "console" | "terminal";

export const SKIN_IDS: readonly SkinId[] = ["console", "terminal"];
export const DEFAULT_SKIN: SkinId = "console";
