// The browser login providers a deployment may switch on (ADR-0058).

export const LOGIN_PROVIDER_IDS = ["telegram", "google", "password"] as const;

export type LoginProviderId = (typeof LOGIN_PROVIDER_IDS)[number];

export function isLoginProviderId(value: unknown): value is LoginProviderId {
  return (LOGIN_PROVIDER_IDS as readonly unknown[]).includes(value);
}
