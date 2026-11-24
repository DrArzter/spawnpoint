// Writes the tool list the local MCP adapter registers from (mcp/src/tools.generated.json),
// derived from the route table's catalogue (ADR-0095). Loading the route table
// needs the API's environment; nothing here reaches AWS.
import "../test/support/api-environment.ts";

import { writeFile } from "node:fs/promises";

const { deployedTools } = await import("../src/handlers/api/route-table.ts");
const { PROFILE_TOOL } = await import("../src/handlers/api/mcp.ts");
const { localToolsJson } = await import("../src/handlers/api/tool-catalogue.ts");

await writeFile(new URL("../../mcp/src/tools.generated.json", import.meta.url), localToolsJson(deployedTools().tools, [PROFILE_TOOL]));
