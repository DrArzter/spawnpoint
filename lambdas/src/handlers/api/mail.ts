import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { type EmailSender } from "../../email/email-sender.ts";
import { configuredEmailSender } from "../../email/email-delivery.ts";
import { panelUrl } from "./origins.ts";
import { ssm } from "./clients.ts";

export const emailDeliveryProvider = process.env.EMAIL_DELIVERY_PROVIDER ?? "none";

let emailSenderPromise: Promise<EmailSender | null> | undefined;

export function emailSender(): Promise<EmailSender | null> {
  emailSenderPromise ??= (async () => {
    if (emailDeliveryProvider !== "none" && !panelUrl) throw new Error("email delivery is incompletely configured: no panel URL");
    return configuredEmailSender(process.env, {
      readSecret: async (name) => (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter?.Value ?? "",
      sesClient: () => new SESv2Client({}),
    });
  })();
  return emailSenderPromise;
}
