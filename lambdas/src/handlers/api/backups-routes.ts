import { permissionRoute, type Route } from "./routing.ts";
import { deployedBackups } from "./backups-wiring.ts";
import { parameter } from "./http.ts";

export const backupsRoutes: Readonly<Record<string, Route>> = {
  "GET /games/{gameId}/worlds/{worldId}/backups": permissionRoute("backup.read", (_identity, event) =>
    deployedBackups.backups(parameter(event, "gameId"), parameter(event, "worldId")), {
    name: "list_world_backups", title: "List world backups", effect: "read", mcp: true,
    description: "List recoverable backups for one Spawnpoint world.",
  }),
  // A whole save, under its own permission. The download is recorded against
  // the Identity; it changes no world, so it is a read.
  "POST /games/{gameId}/worlds/{worldId}/backups/download": permissionRoute("backup.download", (identity, event) =>
    deployedBackups.backupDownload(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body), {
    name: "get_backup_download_link", title: "Get backup download link", effect: "read", mcp: true,
    description: "Create a download link, valid for five minutes, for one backup archive of a world, named by its key from list_world_backups. Who asked is recorded.",
    input: { key: { type: "string", minLength: 1, description: "The archive's key from list_world_backups" } },
    required: ["key"],
  }),
};
