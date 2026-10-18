import { publicRoute, type Route } from "./routing.ts";
import { loginProviders, authenticate, telegramProvider, googleProvider, loginProviderDisabled, passwordProvider } from "./login-providers.ts";
import { googleLoginEnabled, passwordLoginEnabled, passwordRegistrationEnabled } from "./auth-config.ts";
import { emailDeliveryProvider } from "./mail.ts";
import { registerPassword } from "./passwords.ts";
import { verifyEmail, resendEmailVerification, requestPasswordReset, resetPassword } from "./email-actions.ts";
import { refreshLoginSession, logoutLoginSession } from "./login-sessions.ts";

export const authRoutes: Readonly<Record<string, Route>> = {
  "GET /auth/providers": publicRoute(() => loginProviders()),
  "POST /auth/telegram": publicRoute((event) => authenticate(telegramProvider, event)),
  "POST /auth/google": publicRoute((event) => (googleLoginEnabled ? authenticate(googleProvider, event) : loginProviderDisabled())),
  "POST /auth/password": publicRoute((event) => (passwordLoginEnabled ? authenticate(passwordProvider, event) : loginProviderDisabled())),
  "POST /auth/password/register": publicRoute((event) => (
    passwordLoginEnabled && passwordRegistrationEnabled && emailDeliveryProvider !== "none"
      ? registerPassword(event)
      : loginProviderDisabled()
  )),
  "POST /auth/email/verification": publicRoute((event) => verifyEmail(event)),
  "POST /auth/email/verification/resend": publicRoute((event) => resendEmailVerification(event)),
  "POST /auth/password/forgot": publicRoute((event) => requestPasswordReset(event)),
  "POST /auth/password/reset": publicRoute((event) => resetPassword(event)),
  "POST /auth/refresh": publicRoute((event) => refreshLoginSession(event)),
  "POST /auth/logout": publicRoute((event) => logoutLoginSession(event))
};
