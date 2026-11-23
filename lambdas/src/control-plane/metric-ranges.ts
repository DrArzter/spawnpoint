/**
 * The windows a metrics request may ask for, in hours. The API, the MCP tool
 * schema and the standalone MCP server (`mcp/src/server.ts`, held to this list
 * by a test) offer exactly these.
 */
export const METRIC_RANGES: Readonly<Record<string, number>> = { "6h": 6, "24h": 24, "7d": 168 };

export const METRIC_RANGE_NAMES: readonly string[] = Object.keys(METRIC_RANGES);
