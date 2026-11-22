// The states the gate opens: every dialog, side panel, drawer, tooltip and
// toast the console can show. A step is one of:
//   { action: id }        press the control for this Action: the visible one,
//                         else open the menu that holds it and press it there
//   { click: selector }   press the first visible match
//   { focus: selector }   focus the first visible match (a tooltip shows)
//   { key: "?" }          press a key on the page
// `phoneOnly` names the skins whose control shows only under 960px, so the
// gate does not expect it at 1440.
// Row and page menus need no entry: the gate opens every menu on every page.
// test/ui-audit-states.test.ts holds every surface in the skins to an entry here.

const WORLD = "/?demo&latency=0#/worlds/minecraft/minecraft-rostik-12345678";

export const STATES = [
  // The console top bar names every game at desktop widths; its scope dialog is the phone's.
  { name: "scope", route: "/?demo&latency=0#/worlds/minecraft", steps: [{ action: "scope.show" }], phoneOnly: ["console"] },
  { name: "create-world", route: "/?demo&latency=0#/worlds/minecraft", steps: [{ action: "world.create" }] },
  { name: "world-settings", route: WORLD, steps: [{ action: "world.settings" }] },
  { name: "game-settings", route: WORLD, steps: [{ action: "world.game-settings" }] },
  { name: "invite", route: WORLD, steps: [{ action: "world.invite" }] },
  { name: "stop", route: WORLD, steps: [{ action: "session.stop" }] },
  { name: "archive", route: "/?demo&latency=0#/worlds/minecraft", steps: [{ action: "world.archive" }] },
  { name: "wipe", route: `${WORLD}/wipes`, steps: [{ action: "world.wipe" }] },
  { name: "restore", route: `${WORLD}/backups`, steps: [{ action: "backup.restore" }] },
  { name: "promote", route: "/?demo&latency=0#/worlds/minecraft/minecraft-creative-5e1c9a07", steps: [{ action: "world.promote" }] },
  { name: "linked-accounts", route: "/?demo&latency=0#/access/users", steps: [{ action: "access.linked" }] },
  { name: "delete-user", route: "/?demo&latency=0#/access/users", steps: [{ action: "access.delete" }] },
  { name: "role", route: "/?demo&latency=0#/access/roles", steps: [{ action: "access.role.read" }] },
  // The terminal draws the password form in the page, not on a surface.
  { name: "password", route: "/?demo&latency=0#/profile", steps: [{ action: "accounts.password.change" }], skins: ["console"] },
  { name: "shortcuts", route: "/?demo&latency=0#/worlds/minecraft", steps: [{ key: "?" }], skins: ["console"] },
  { name: "tooltip", route: WORLD, steps: [{ focus: "[data-tip]" }], skins: ["console"] },
  // A mod's source is a mark with its name in the tooltip. The mods sit below the fold: the second focus lands after the scroll that closed the first tip.
  { name: "mod-source", route: `${WORLD}/releases`, steps: [{ focus: "table[aria-label=Mods] [data-tip]" }, { focus: "table[aria-label=Mods] [data-tip]" }], skins: ["console"] },
  { name: "mod-source-terminal", route: `${WORLD}/releases`, steps: [{ focus: "table[aria-label^='Mods of'] .t-indicator" }], skins: ["terminal"] },
  { name: "toast", route: "/?demo&latency=0#/releases/minecraft", steps: [{ click: "[aria-disabled=true][data-action]" }], skins: ["console"] },
];

// Every surface the skins draw, by file and by the function that draws it,
// and the states that open it. web/test/ui-audit-states.test.ts reads the
// skins' sources: each Dialog, SidePanel, Modal and Drawer must sit in a
// function listed here, with at least as many states as it draws surfaces.
export const SURFACES = {
  console: {
    "Shell.tsx": { Shell: ["shortcuts"] },
    "Access.tsx": { LinkedAccountsPanel: ["linked-accounts"], RolesPane: ["role"] },
    "Scope.tsx": { ScopeDialog: ["scope"] },
    "Profile.tsx": { PasswordPanel: ["password"] },
    "Dialogs.tsx": {
      ConfirmationDialog: ["stop", "archive", "wipe", "restore", "promote", "delete-user"],
      CreateWorldSheet: ["create-world"],
      WorldSettingsSheet: ["world-settings"],
      GameSettingsSheet: ["game-settings"],
      InvitationSheet: ["invite"],
    },
  },
  terminal: {
    "Access.tsx": { Users: ["linked-accounts"], Roles: ["role"] },
    "Dialogs.tsx": {
      ScopeDialog: ["scope"],
      ConfirmationDialog: ["stop", "archive", "wipe", "restore", "promote", "delete-user"],
      CreateWorldSheet: ["create-world"],
      WorldSettingsSheet: ["world-settings"],
      GameSettingsSheet: ["game-settings"],
      InvitationSheet: ["invite"],
    },
  },
};
