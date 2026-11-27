/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ACCESS_API_URL?: string;
  readonly VITE_TELEGRAM_OIDC_CLIENT_ID?: string;
  /** Empty in every deployment that has not created a Google OAuth client. */
  readonly VITE_GOOGLE_OIDC_CLIENT_ID?: string;
  /** Comma-separated skins to switch on in place of the list in skins/skin.ts (ADR-0106). */
  readonly VITE_ENABLED_SKINS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
