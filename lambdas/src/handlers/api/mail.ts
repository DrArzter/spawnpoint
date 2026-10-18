import { type EmailSender } from "../../email/email-sender.ts";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { createResendEmailSender } from "../../email/resend-email-sender.ts";
import { panelUrl } from "./origins.ts";
import { ssm } from "./clients.ts";

export const emailDeliveryProvider = process.env.EMAIL_DELIVERY_PROVIDER ?? "none";

let emailSenderPromise: Promise<EmailSender | null> | undefined;

export function emailSender(): Promise<EmailSender | null> {
  emailSenderPromise ??= (async () => {
    if (emailDeliveryProvider === "none") return null;
    if (emailDeliveryProvider !== "resend") throw new Error(`unsupported email delivery provider: ${emailDeliveryProvider}`);
    const parameterName = process.env.RESEND_API_KEY_PARAMETER;
    const from = process.env.EMAIL_FROM;
    if (!parameterName || !from || !panelUrl) throw new Error("email delivery is incompletely configured");
    const result = await ssm.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
    const apiKey = result.Parameter?.Value;
    if (!apiKey) throw new Error("Resend API key parameter is empty");
    const replyTo = process.env.EMAIL_REPLY_TO?.trim();
    return createResendEmailSender({ apiKey, from, ...(replyTo ? { replyTo } : {}) });
  })();
  return emailSenderPromise;
}
