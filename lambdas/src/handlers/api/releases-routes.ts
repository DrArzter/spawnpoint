import { permissionRoute, type Route } from "./routing.ts";
import { deployedReleases } from "./releases-wiring.ts";
import { parameter } from "./http.ts";

export const releasesRoutes: Readonly<Record<string, Route>> = {
  // ADR-0065: a release's mods, listed with their SHA-256 digests, and one
  // mod's link by its digest; the players' own set too (ADR-0069).
  "GET /games/{gameId}/presets/{presetId}/releases/{version}": permissionRoute("release.read", (_identity, event) =>
    deployedReleases.releaseManifest(parameter(event, "gameId"), parameter(event, "presetId"), parameter(event, "version"), event.queryStringParameters), {
    name: "get_release", title: "Get release", effect: "read", mcp: true,
    description: "Read one release: its loader, runtime, source preset, server mods and, when players install a different set, the players' mods, each with its SHA-256 digest.",
  }),
  "GET /games/{gameId}/presets/{presetId}/releases/{version}/diff": permissionRoute("release.read", (_identity, event) =>
    deployedReleases.releaseDiff(parameter(event, "gameId"), parameter(event, "presetId"), parameter(event, "version"), event.queryStringParameters?.from), {
    name: "get_release_diff", title: "Compare releases", effect: "read",
    description: "Read what a release changes: the mods and files added, removed or changed, against another release or the one its build compared it with.",
    input: { from: { type: "string", pattern: String.raw`^\d+\.\d+$`, description: "The release to compare with; left out, the one its build compared it with" } },
  }),
  "POST /games/{gameId}/presets/{presetId}/builds": permissionRoute("release.build", (identity, event) =>
    deployedReleases.buildRelease(identity, parameter(event, "gameId"), parameter(event, "presetId"), event.body), {
    name: "build_release", title: "Build release", effect: "write",
    description: "Build a new release of a preset from its current definition, or retry a failed build. Building takes several minutes; follow it in get_control_plane.",
    input: {
      profileDigest: { type: "string", pattern: "^[0-9a-f]{64}$", description: "The preset definition's digest from get_control_plane, so a preset that changed meanwhile is refused" },
      retryRelease: { type: "string", pattern: String.raw`^\d+\.\d+$`, description: "A failed release to build again" },
    },
    required: ["profileDigest"],
  }),
  "POST /games/{gameId}/presets/{presetId}/releases/{version}/retire": permissionRoute("release.retire", (identity, event) =>
    deployedReleases.requestReleaseRetirement(identity, parameter(event, "gameId"), parameter(event, "presetId"), parameter(event, "version"), event.body), {
    name: "retire_release", title: "Retire release", effect: "write", destructive: true,
    description: "Retire a release so no world can move onto it, and remove its files once no world uses it.",
    input: { confirmation: { type: "string", description: "gameId/presetId@version, to confirm" } },
    required: ["confirmation"],
  }),
  "GET /games/{gameId}/worlds/{worldId}/pack": permissionRoute("connection.read", (_identity, event) =>
    deployedReleases.packDownload(parameter(event, "gameId"), parameter(event, "worldId")), {
    name: "get_world_pack", title: "Get world client pack", effect: "read", mcp: true,
    description: "Create a temporary download link for the client pack used by the world's active release.",
  }),
  "GET /games/{gameId}/presets/{presetId}/releases/{version}/mods/{sha256}": permissionRoute("release.read", (_identity, event) =>
    deployedReleases.releaseModDownload(parameter(event, "gameId"), parameter(event, "presetId"), parameter(event, "version"), parameter(event, "sha256")), {
    name: "get_release_mod_link", title: "Get release mod link", effect: "read", mcp: true,
    description: "Create a download link, valid for fifteen minutes, for one mod of a release, server or players', named by its SHA-256 digest from get_release.",
  }),
  "GET /games/{gameId}/presets/{presetId}/releases/{version}/packs/{pack}": permissionRoute("release.read", (_identity, event) =>
    deployedReleases.releasePackDownload(parameter(event, "gameId"), parameter(event, "presetId"), parameter(event, "version"), parameter(event, "pack")), {
    name: "get_release_pack_link", title: "Get release pack link", effect: "read",
    description: "Create a temporary download link for a release's server pack or full client pack.",
  }),
};
