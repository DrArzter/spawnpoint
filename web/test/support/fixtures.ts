import { action, type Action } from "../../src/core/actions.ts";
import { roleEditAction, roleRemoveAction } from "../../src/core/data.ts";
import type { RolesModel, ShellModel, WorldsModel } from "../../src/core/models.ts";
import { defaultRoleChoice } from "../../src/core/roles.ts";
import type { Game, Member, PermissionInfo, Preset, Role, World } from "../../src/model.ts";

// Typed builders for the models the tests draw. Each takes the fields a test
// cares about and fills the rest, so a test names only what it asserts on and
// no test casts a partial value through `unknown`.

export const noop = () => undefined;

/** An Action that does nothing; `rest` sets its icon, hint, disabled flag and the like. */
export const spy = (id: string, label: string, rest: Partial<Action> = {}): Action => action(id, label, noop, rest);

export function aPreset(over: Partial<Preset> = {}): Preset {
  return {
    id: "industrial",
    displayName: "Industrial",
    repository: "https://github.com/DrArzter/presets",
    commit: "0123456789abcdef",
    profileDigest: "sha256:0",
    releases: ["1.1", "1.2"],
    buildStatus: "ready",
    latestRelease: "1.2",
    ...over,
  };
}

export function aWorld(over: Partial<World> = {}): World {
  return {
    id: "minecraft-rostik-12345678",
    displayName: "Rostik",
    profileId: "industrial",
    sessionControlAvailable: true,
    connectivity: "zerotier",
    placement: "configured",
    materialization: "existing",
    worldLifecycleAvailable: true,
    wipes: [],
    preset: null,
    connectionAddress: null,
    release: { state: "available", generationId: null, desiredRelease: "1.2", activeRelease: "1.2" },
    ...over,
  };
}

/** The Minecraft game, with the worlds and presets a test gives it. */
export function aGame(over: Partial<Game> = {}): Game {
  return { id: "minecraft", code: "MC", displayName: "Minecraft", lifecycle: null, presets: [], worlds: [], ...over };
}

/** A shell model for a game that is open on the Worlds page. */
export function aShell(game: Game, over: Partial<ShellModel> = {}): ShellModel {
  return {
    navigation: [{ id: "worlds", label: "Worlds", href: "#/worlds/minecraft", current: true }, { id: "access", label: "Access", href: "#/access/users", current: false }],
    page: "worlds",
    scope: { game, games: [game], statusOf: () => ({ kind: "ok", label: "Online" }), open: false, show: spy("scope.show", "Minecraft"), close: spy("scope.close", "Cancel"), select: noop },
    viewer: { displayName: "DrArzter", inTelegram: false },
    demo: true,
    observedAt: "Nov 21, 2026, 10:00 AM",
    openProfile: spy("shell.profile", "Open my profile"),
    ...over,
  };
}

/** A ready, stopped Worlds model for a game; its rows are the test's own. */
export function aWorlds(game: Game, over: Partial<WorldsModel> = {}): WorldsModel {
  return {
    status: "ready",
    error: "",
    game,
    unavailable: null,
    notices: [],
    overview: { fleet: true, state: "stopped", status: { kind: "off", label: "Stopped" }, headline: "Minecraft stopped", reason: { text: "", detail: "", attention: false }, players: null, observedAt: undefined, host: null, fleetHosts: { running: 0, pending: 0 } },
    rows: [],
    emptyDescription: null,
    refresh: spy("refresh", "Refresh"),
    createWorld: spy("world.create", "Create world"),
    ...over,
  };
}

/** A role as the API serves it; the ids and names here are test data, not the product's. */
export function aRole(over: Partial<Role> = {}): Role {
  return { id: "role-a", name: "Role A", description: "A role.", permissions: ["perm.one"], builtIn: true, protected: false, assignable: true, version: 1, holders: 0, editable: true, deletable: false, ...over };
}

export function aMember(over: Partial<Member> = {}): Member {
  return { id: "member-a", name: "Member A", roleId: "role-a", links: [], canDelete: true, ...over };
}

export function aPermission(over: Partial<PermissionInfo> = {}): PermissionInfo {
  return { id: "perm.one", group: "Group One", label: "Do one", description: "Does the first thing.", reserved: false, ...over };
}

/** A roles tab as the hook serves it, with the edit and delete actions built from the role flags. */
export function aRolesModel(roles: readonly Role[], over: Partial<RolesModel> = {}): RolesModel {
  return {
    roles: { status: "ready", value: roles },
    reading: null,
    read: (role) => action("access.role.read", `${role.permissions.length} permissions`, () => undefined),
    closeReading: action("sheet.close.role", "Close panel", () => undefined),
    create: action("access.role.create", "New role", () => undefined),
    edit: (role) => roleEditAction(role, () => undefined),
    remove: (role) => roleRemoveAction(role, roles[0]?.id ?? null, () => undefined),
    editor: null,
    deletion: null,
    defaultRole: { choice: defaultRoleChoice(roles, roles[0]?.id ?? null, false), set: () => undefined },
    ...over,
  };
}
