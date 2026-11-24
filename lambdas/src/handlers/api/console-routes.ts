import { permissionRoute, type Route } from "./routing.ts";
import { deployedConsole } from "./console-wiring.ts";
import { parameter } from "./http.ts";

// ADR-0063, amended: the console, as the person who asked, under the same
// permission and refusals for the panel and every agent. The record names the
// agent too, when a tool call came through one (ADR-0095).
export const consoleRoutes: Readonly<Record<string, Route>> = {
  "POST /games/{gameId}/worlds/{worldId}/console": permissionRoute("console.use", (identity, event) =>
    deployedConsole.runConsoleCommand(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body, event.agent ?? null), {
    name: "send_console_command", title: "Send console command", effect: "write", destructive: true, mcp: true,
    description: "Send one console command to a running world, as the connected person. Commands that stop the game outside its lifecycle are refused. The command is recorded with the person's and this client's names. Returns the command's id; read its answer with get_console_result.",
    input: { command: { type: "string", minLength: 1, description: "One line, as typed in the game's console" } },
    required: ["command"],
  }),
  "GET /games/{gameId}/worlds/{worldId}/console": permissionRoute("console.use", (_identity, event) =>
    deployedConsole.consoleHistory(parameter(event, "gameId"), parameter(event, "worldId")), {
    name: "get_console_history", title: "Get console history", effect: "read",
    description: "Read a world's recent console commands, newest first, with who ran each and the game's answer.",
  }),
  "GET /games/{gameId}/worlds/{worldId}/console/{commandId}": permissionRoute("console.use", (_identity, event) =>
    deployedConsole.consoleCommandResult(parameter(event, "gameId"), parameter(event, "worldId"), parameter(event, "commandId")), {
    name: "get_console_result", title: "Get console result", effect: "read", mcp: true,
    description: "Read the answer to one console command by the id send_console_command returned. Its status stays pending until the game answers.",
  }),
};
