import { isLoginProviderId, type LoginProviderId } from "../../../contract/login";
import { t } from "../i18n";

// The API is the authority on what a password must be; these mirror its rules
// so the form can say them before a round trip, and read its refusals after.
export const PASSWORD_MINIMUM_LENGTH = 12;
export const PASSWORD_MAXIMUM_LENGTH = 128;
export const DISPLAY_NAME_MAXIMUM_LENGTH = 80;

/** An OAuth client id from the Google Cloud console, the same test the API applies. */
export const GOOGLE_CLIENT_ID = /^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/;

export { isLoginProviderId, type LoginProviderId };

// A provider's refusal, in the same voice as the password form's: a route that
// is not deployed reads as "not offered", every other failure as "start again".
export function describeProviderSignInFailure(label: string, status: number, code: string | undefined): string {
  if (status === 404 && code === "not_found") return t("signin.labelSignInNotOffered", { label });
  return t("signin.labelCouldNotVerifySignIn", { label });
}

// One sentence for a refused sign-in. A wrong email and a wrong password read
// the same on purpose: the API does not say which, and neither does the panel.
export function describeSignInFailure(status: number, code: string | undefined): string {
  if (status === 401) return t("signin.emailPasswordDoNot");
  if (status === 404 && code === "not_found") return t("signin.emailSignInNotOffered");
  return t("signin.signInDidNotComplete");
}

export function describeRegistrationFailure(status: number, code: string | undefined): string {
  const byCode: Record<string, string> = {
    invalid_email: t("error.invalid_email"),
    password_too_short: t("error.password_too_short", { PASSWORD_MINIMUM_LENGTH }),
    password_too_long: t("error.password_too_long", { PASSWORD_MAXIMUM_LENGTH }),
    invalid_display_name: t("signin.enterDisplayName1", { DISPLAY_NAME_MAXIMUM_LENGTH }),
    email_already_registered: t("signin.accountEmailAlreadyExists"),
  };
  if (code !== undefined && byCode[code] !== undefined) return byCode[code];
  if (status === 404 && code === "not_found") return t("signin.creatingAccountNotOffered");
  return t("signin.accountCouldNotCreated");
}
