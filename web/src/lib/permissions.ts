// Permission ids are the access directory's own words. They are precise and
// they mean nothing to the person whose role is being explained, so each one
// carries a sentence in the reader's language. An id with no sentence still
// shows, because an unexplained permission is better than a hidden one.
const descriptions: Record<string, string> = {
  "status.read": "See whether a game is running.",
  "connection.read": "See the address a world is reachable at.",
  "session.start": "Start a session on the shared host.",
  "session.stop": "Stop a session, which saves the world and backs it up first.",
  "invitation.send": "Invite players through the Telegram bot.",
  "metrics.read": "Read session metrics.",
  "console.use": "Run RCON commands, recorded against your identity.",
  "release.read": "See presets and the releases built from them.",
  "release.promote": "Move a world onto another release.",
  "backup.read": "List the verified backups of a world.",
  "backup.restore": "Restore a backup, which opens a new wipe.",
  "world.manage": "Create, wipe, archive and permanently delete worlds.",
  "access.read": "See who has access and which role they hold.",
  "access.manage": "Approve people and change their roles.",
};

export function describePermission(permission: string): string | undefined {
  return descriptions[permission];
}
