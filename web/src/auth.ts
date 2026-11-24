import type { Composition } from "./api/context";
import { googleOidcClientId, liveApi, liveAuthConfigured, telegramOidcClientId } from "./api/live";
import { demoApi, demoEnabled } from "./demo";

// The one composition root. One switch, in one place: the shipped panel calls
// the shipped contract; the demo differs in what answers, never in what is
// asked or in what happens next. main.tsx hands this to the ApiProvider.
export const composition: Composition = {
  api: demoEnabled ? demoApi : liveApi,
  signIn: { configured: liveAuthConfigured(), telegramClientId: telegramOidcClientId, googleClientId: googleOidcClientId },
};
