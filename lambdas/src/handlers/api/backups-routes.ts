import { permissionRoute, type Route } from "./routing.ts";
import { backups, backupDownload } from "./backups.ts";
import { parameter } from "./http.ts";

export const backupsRoutes: Readonly<Record<string, Route>> = {
  "GET /games/{gameId}/worlds/{worldId}/backups": permissionRoute("backup.read", (_identity, event) =>
    backups(parameter(event, "gameId"), parameter(event, "worldId"))),
  "POST /games/{gameId}/worlds/{worldId}/backups/download": permissionRoute("backup.download", (identity, event) =>
    backupDownload(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body))
};
