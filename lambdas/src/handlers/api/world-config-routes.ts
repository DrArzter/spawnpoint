import { permissionRoute, type Route } from "./routing.ts";
import { deployedWorldConfig } from "./world-config-wiring.ts";
import { parameter } from "./http.ts";

const PATH = { type: "string", minLength: 1, description: "The file's path from list_config_files, for example config/claims.toml" } as const;

// A world's own config files (ADR-0093), for whoever holds config.edit.
export const worldConfigRoutes: Readonly<Record<string, Route>> = {
  "GET /games/{gameId}/worlds/{worldId}/config-files": permissionRoute("config.edit", (_identity, event) =>
    deployedWorldConfig.listConfigFiles(parameter(event, "gameId"), parameter(event, "worldId")), {
    name: "list_config_files", title: "List config files", effect: "read",
    description: "List the config files a world may edit: the release's files and the world's own versions, with their digests.",
  }),
  "GET /games/{gameId}/worlds/{worldId}/config-files/content": permissionRoute("config.edit", (_identity, event) =>
    deployedWorldConfig.readConfigFile(parameter(event, "gameId"), parameter(event, "worldId"), event.queryStringParameters?.path), {
    name: "read_config_file", title: "Read config file", effect: "read",
    description: "Read one config file as the world's next start will write it, with its SHA-256 digest.",
    input: { path: PATH },
    required: ["path"],
  }),
  "PUT /games/{gameId}/worlds/{worldId}/config-files": permissionRoute("config.edit", (identity, event) =>
    deployedWorldConfig.saveConfigFile(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body), {
    name: "save_config_file", title: "Save config file", effect: "write",
    description: "Save the whole text of one config file as the world's own version. It applies at the world's next start.",
    input: {
      path: PATH,
      text: { type: "string", description: "The file's whole new text" },
      expectedSha256: { type: ["string", "null"], description: "The digest read_config_file returned, so a file changed meanwhile is refused; null for a new file" },
    },
    required: ["path", "text", "expectedSha256"],
  }),
  "DELETE /games/{gameId}/worlds/{worldId}/config-files": permissionRoute("config.edit", (identity, event) =>
    deployedWorldConfig.resetConfigFile(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.queryStringParameters?.path, event.queryStringParameters?.expected), {
    name: "reset_config_file", title: "Reset config file", effect: "write", destructive: true,
    description: "Drop the world's own version of a config file, so the next start takes the release's file.",
    input: { path: PATH, expected: { type: "string", description: "The world's version's digest from list_config_files" } },
    required: ["path"],
  }),
};
