// The environment the API's modules read when they load, for a test that
// imports the route table. Nothing here reaches AWS.
process.env.ACCESS_TABLE_NAME ??= "spawnpoint-access-test";
process.env.BOT_TOKEN_PARAMETER ??= "/spawnpoint/bot/token";
process.env.CONTROL_PLANE_VIEW_TABLE ??= "spawnpoint-control-plane-view-test";
process.env.CONTROL_PLANE_WEBSOCKET_URL ??= "wss://socket.example.test/live";
process.env.SESSION_SIGNING_SECRET_PARAMETER ??= "/spawnpoint/auth/session-signing-secret";
process.env.API_URL ??= "https://api.spawnpoint.example";
process.env.PANEL_URL ??= "https://spawnpoint.example";
