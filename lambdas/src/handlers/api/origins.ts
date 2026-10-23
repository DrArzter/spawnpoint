export const panelUrl = (process.env.PANEL_URL ?? "").trim();

export const legacyPanelUrl = (process.env.LEGACY_PANEL_URL ?? "").trim();

export const apiUrl = (process.env.API_URL ?? "").trim().replace(/\/$/, "");
