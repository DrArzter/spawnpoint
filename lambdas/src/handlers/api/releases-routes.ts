import { permissionRoute, type Route } from "./routing.ts";
import { releaseManifest, buildRelease, packDownload, releaseModDownload, releasePackDownload } from "./releases.ts";
import { parameter } from "./http.ts";

export const releasesRoutes: Readonly<Record<string, Route>> = {
  "GET /games/{gameId}/presets/{presetId}/releases/{version}": permissionRoute("release.read", (_identity, event) =>
    releaseManifest(parameter(event, "gameId"), parameter(event, "presetId"), parameter(event, "version"))),
  "POST /games/{gameId}/presets/{presetId}/builds": permissionRoute("release.build", (identity, event) =>
    buildRelease(identity, parameter(event, "gameId"), parameter(event, "presetId"), event.body)),
  "GET /games/{gameId}/worlds/{worldId}/pack": permissionRoute("connection.read", (_identity, event) =>
    packDownload(parameter(event, "gameId"), parameter(event, "worldId"))),
  "GET /games/{gameId}/presets/{presetId}/releases/{version}/mods/{sha256}": permissionRoute("release.read", (_identity, event) =>
    releaseModDownload(parameter(event, "gameId"), parameter(event, "presetId"), parameter(event, "version"), parameter(event, "sha256"))),
  "GET /games/{gameId}/presets/{presetId}/releases/{version}/packs/{pack}": permissionRoute("release.read", (_identity, event) =>
    releasePackDownload(parameter(event, "gameId"), parameter(event, "presetId"), parameter(event, "version"), parameter(event, "pack")))
};
