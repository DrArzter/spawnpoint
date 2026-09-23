// The API is the authority on what a password must be; these mirror its rules
// so the form can say them before a round trip, and read its refusals after.
export const PASSWORD_MINIMUM_LENGTH = 12;
export const PASSWORD_MAXIMUM_LENGTH = 128;
export const DISPLAY_NAME_MAXIMUM_LENGTH = 80;

/** An OAuth client id from the Google Cloud console, the same test the API applies. */
export const GOOGLE_CLIENT_ID = /^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/;

export type LoginProviderId = "telegram" | "google" | "password";

export function isLoginProviderId(value: unknown): value is LoginProviderId {
  return value === "telegram" || value === "google" || value === "password";
}

// A provider's refusal, in the same voice as the password form's: a route that
// is not deployed reads as "not offered", every other failure as "start again".
export function describeProviderSignInFailure(label: string, status: number, code: string | undefined): string {
  if (status === 404 && code === "not_found") return `${label} sign-in is not offered on this deployment.`;
  return `${label} could not verify this sign-in. Please start again.`;
}

// One sentence for a refused sign-in. A wrong email and a wrong password read
// the same on purpose: the API does not say which, and neither does the panel.
export function describeSignInFailure(status: number, code: string | undefined): string {
  if (status === 401) return "That email and password do not match, or the account is locked after too many attempts.";
  if (status === 404 && code === "not_found") return "Email sign-in is not offered on this deployment.";
  return "Sign-in did not complete. Try again.";
}

export function describeRegistrationFailure(status: number, code: string | undefined): string {
  const byCode: Record<string, string> = {
    invalid_email: "Enter a valid email address.",
    password_too_short: `Use a password of at least ${PASSWORD_MINIMUM_LENGTH} characters. Length matters more than symbols.`,
    password_too_long: `Use a password of at most ${PASSWORD_MAXIMUM_LENGTH} characters.`,
    invalid_display_name: `Enter a display name of 1 to ${DISPLAY_NAME_MAXIMUM_LENGTH} characters.`,
    email_already_registered: "An account with this email already exists. Sign in instead.",
  };
  if (code !== undefined && byCode[code] !== undefined) return byCode[code];
  if (status === 404 && code === "not_found") return "Creating an account is not offered on this deployment.";
  return "The account could not be created. Try again.";
}
