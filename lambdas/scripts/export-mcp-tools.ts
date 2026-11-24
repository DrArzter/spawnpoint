// Writes the tool list the local MCP adapter registers from (mcp/src/tools.generated.json).
import { writeFile } from "node:fs/promises";

import { localMcpToolsJson } from "../src/access/mcp-tools.ts";

await writeFile(new URL("../../mcp/src/tools.generated.json", import.meta.url), localMcpToolsJson());
