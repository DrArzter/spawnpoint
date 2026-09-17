import type { LoginPrincipal } from "./login-session.ts";
import type { LoginAttempt, LoginProvider } from "./login-provider.ts";
import {
  verifyLoginWidget,
  verifyMiniAppInitData,
  verifyOidcIdToken,
  type TelegramProfile,
} from "./telegram-auth.ts";

type TelegramLoginProviderDependencies = Readonly<{
  oidcClientId: string;
  botToken(): Promise<string>;
  nowSeconds?(): number;
}>;

export function telegramPrincipal(profile: TelegramProfile): LoginPrincipal {
  return {
    provider: "telegram",
    subject: profile.telegramId,
    displayName: profile.displayName,
    username: profile.username,
    photoUrl: profile.photoUrl,
    email: null,
  };
}

export function createTelegramLoginProvider(
  dependencies: TelegramLoginProviderDependencies,
): LoginProvider {
  return {
    id: "telegram",
    async authenticate(attempt: LoginAttempt): Promise<LoginPrincipal | null> {
      let profile: TelegramProfile | null;
      const nowSeconds = dependencies.nowSeconds?.();
      if (typeof attempt.idToken === "string" && dependencies.oidcClientId !== "") {
        profile = await verifyOidcIdToken(attempt.idToken, dependencies.oidcClientId, nowSeconds);
      } else if (typeof attempt.initData === "string") {
        profile = verifyMiniAppInitData(attempt.initData, await dependencies.botToken(), nowSeconds);
      } else if (attempt.login !== null && typeof attempt.login === "object") {
        profile = verifyLoginWidget(
          attempt.login as Readonly<Record<string, unknown>>,
          await dependencies.botToken(),
          nowSeconds,
        );
      } else {
        profile = null;
      }
      return profile === null ? null : telegramPrincipal(profile);
    },
  };
}
