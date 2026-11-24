// Writes the tool lists derived from the route table's catalogue (ADR-0095):
// the one the local MCP adapter registers from (mcp/src/tools.generated.json),
// and the assistant worker's (ADR-0096), which does not load the route table. Loading the route table
// needs the API's environment; nothing here reaches AWS.
import "../test/support/api-environment.ts";

import { writeFile } from "node:fs/promises";

const { deployedTools } = await import("../src/handlers/api/route-table.ts");
const { PROFILE_TOOL } = await import("../src/handlers/api/mcp.ts");
const { assistantToolsJson, localToolsJson } = await import("../src/handlers/api/tool-catalogue.ts");

await writeFile(new URL("../../mcp/src/tools.generated.json", import.meta.url), localToolsJson(deployedTools().tools, [PROFILE_TOOL]));
await writeFile(new URL("../src/control-plane/assistant-tools.generated.json", import.meta.url), assistantToolsJson(deployedTools().tools));
