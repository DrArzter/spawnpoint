// The states the gate opens: every dialog, side panel, drawer, tooltip and
// toast the console can show. A step is one of:
//   { action: id }        press the control for this Action: the visible one,
//                         else open the menu that holds it and press it there
//   { click: selector }   press the first visible match
//   { focus: selector }   focus the first visible match (a tooltip shows)
//   { key: "?" }          press a key on the page
// Row and page menus need no entry: the gate opens every menu on every page.
// test/ui-audit-states.test.ts holds every surface in the skins to an entry here.

const WORLD = "/?demo&latency=0#/worlds/minecraft/minecraft-rostik-12345678";

export const STATES = [
  { name: "scope", route: "/?demo&latency=0#/worlds/minecraft", steps: [{ action: "scope.show" }] },
  { name: "create-world", route: "/?demo&latency=0#/worlds/minecraft", steps: [{ action: "world.create" }] },
  { name: "world-settings", route: WORLD, steps: [{ action: "world.settings" }] },
  { name: "game-settings", route: WORLD, steps: [{ action: "world.game-settings" }] },
  { name: "invite", route: WORLD, steps: [{ action: "world.invite" }] },
  { name: "stop", route: WORLD, steps: [{ action: "session.stop" }] },
  { name: "archive", route: "/?demo&latency=0#/worlds/minecraft", steps: [{ action: "world.archive" }] },
  { name: "wipe", route: `${WORLD}/wipes`, steps: [{ action: "world.wipe" }] },
  { name: "restore", route: `${WORLD}/backups`, steps: [{ action: "backup.restore" }] },
  { name: "linked-accounts", route: "/?demo&latency=0#/access/users", steps: [{ action: "access.linked" }] },
  { name: "delete-user", route: "/?demo&latency=0#/access/users", steps: [{ action: "access.delete" }] },
  { name: "role", route: "/?demo&latency=0#/access/roles", steps: [{ action: "access.role.read" }] },
  // The terminal draws the password form in the page, not on a surface.
  { name: "password", route: "/?demo&latency=0#/profile", steps: [{ action: "accounts.password.change" }], skins: ["cloud"] },
  { name: "shortcuts", route: "/?demo&latency=0#/worlds/minecraft", steps: [{ key: "?" }], skins: ["cloud"] },
  { name: "tooltip", route: WORLD, steps: [{ focus: "[data-tip]" }], skins: ["cloud"] },
  { name: "toast", route: "/?demo&latency=0#/releases/minecraft", steps: [{ click: "[aria-disabled=true][data-action]" }], skins: ["cloud"] },
];

// The component that draws each surface, per skin, and the state that opens
// it. The contract test reads the skins' sources for every Dialog, SidePanel,
// Modal and Drawer and fails on one that is missing here.
export const SURFACES = {
  cloud: {
    "Shell.tsx": ["shortcuts"],
    "Access.tsx": ["linked-accounts", "role"],
    "Scope.tsx": ["scope"],
    "Profile.tsx": ["password"],
    "Dialogs.tsx": ["stop", "archive", "wipe", "restore", "delete-user", "create-world", "world-settings", "game-settings", "invite"],
  },
  terminal: {
    "Access.tsx": ["linked-accounts", "role"],
    "Dialogs.tsx": ["scope", "stop", "archive", "wipe", "restore", "delete-user", "create-world", "world-settings", "game-settings", "invite"],
  },
};
