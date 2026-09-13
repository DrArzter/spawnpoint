/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ACCESS_API_URL?: string;
  readonly VITE_TELEGRAM_OIDC_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
