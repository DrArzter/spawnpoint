import type { EmailSender } from "./email-sender.ts";
import { createResendEmailSender } from "./resend-email-sender.ts";
import { createSesEmailSender, type SesClient } from "./ses-email-sender.ts";

export const EMAIL_DELIVERY_PROVIDERS = ["none", "resend", "ses"] as const;
export type EmailDeliveryProvider = (typeof EMAIL_DELIVERY_PROVIDERS)[number];

export type EmailDeliveryEnvironment = Readonly<Record<string, string | undefined>>;

export type EmailDeliveryDependencies = Readonly<{
  readSecret(parameterName: string): Promise<string>;
  sesClient(): SesClient;
}>;

export function emailDeliveryProvider(environment: EmailDeliveryEnvironment): EmailDeliveryProvider {
  const provider = environment.EMAIL_DELIVERY_PROVIDER ?? "none";
  if (!(EMAIL_DELIVERY_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`unsupported email delivery provider: ${provider}`);
  }
  return provider as EmailDeliveryProvider;
}

// The one place an installation's provider becomes an adapter. The API and
// the notifier both build their sender here.
export async function configuredEmailSender(
  environment: EmailDeliveryEnvironment,
  dependencies: EmailDeliveryDependencies,
): Promise<EmailSender | null> {
  const provider = emailDeliveryProvider(environment);
  if (provider === "none") return null;
  const from = environment.EMAIL_FROM?.trim();
  if (!from) throw new Error("email delivery is incompletely configured: EMAIL_FROM is empty");
  const replyTo = environment.EMAIL_REPLY_TO?.trim() || null;
  if (provider === "ses") return createSesEmailSender({ client: dependencies.sesClient(), from, replyTo });
  const parameterName = environment.RESEND_API_KEY_PARAMETER;
  if (!parameterName) throw new Error("email delivery is incompletely configured: RESEND_API_KEY_PARAMETER is empty");
  const apiKey = await dependencies.readSecret(parameterName);
  if (!apiKey) throw new Error("Resend API key parameter is empty");
  return createResendEmailSender({ apiKey, from, replyTo });
}
