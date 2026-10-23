export const bootstrapOwnerTelegramId = (process.env.BOOTSTRAP_OWNER_TELEGRAM_ID ?? "").trim();

export const telegramOidcClientId = (process.env.TELEGRAM_OIDC_CLIENT_ID ?? "").trim();

export const googleOidcClientId = (process.env.GOOGLE_OIDC_CLIENT_ID ?? "").trim();

export const refreshCookieSameSite: "Strict" | "None" = process.env.REFRESH_COOKIE_SAME_SITE === "None" ? "None" : "Strict";

// A sign-in adapter is an optional capability of a deployment (ADR-0045). Off,
// its routes answer as if they were never deployed, so the panel reads them as
// not connected rather than broken.
export const passwordLoginEnabled = (process.env.PASSWORD_LOGIN_ENABLED ?? "false") === "true";

// A browser provider is on exactly when its public client id exists. Telegram
// is the default only because the bot that runs the group already has one; the
// route itself stays, since the Mini App signs in through it with initData.
export const telegramLoginEnabled = telegramOidcClientId !== "";

export const googleLoginEnabled = googleOidcClientId !== "";

export const passwordRegistrationEnabled = (process.env.PASSWORD_REGISTRATION_ENABLED ?? "false") === "true";
