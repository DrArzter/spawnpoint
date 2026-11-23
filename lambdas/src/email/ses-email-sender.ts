import { SendEmailCommand, type SendEmailCommandOutput } from "@aws-sdk/client-sesv2";
import type { EmailSender, SentEmail, TransactionalEmail } from "./email-sender.ts";

export type SesClient = Readonly<{ send(command: SendEmailCommand): Promise<Pick<SendEmailCommandOutput, "MessageId">> }>;

export type SesEmailSenderOptions = Readonly<{
  client: SesClient;
  from: string;
  replyTo?: string | null;
}>;

function required(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || /[\r\n]/.test(trimmed)) throw new Error(`invalid SES ${name}`);
  return trimmed;
}

// SES accepts only ASCII letters, digits, "_" and "-" in tag names and values.
function tagPart(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
}

// SES has no idempotency key. A retried request can send a second copy; the
// links inside a message stay single-use, so a duplicate is harmless.
export function createSesEmailSender(options: SesEmailSenderOptions): EmailSender {
  const from = required(options.from, "from address");
  const replyTo = options.replyTo === undefined || options.replyTo === null || options.replyTo.trim() === ""
    ? null
    : required(options.replyTo, "reply-to address");

  return {
    async send(message: TransactionalEmail): Promise<SentEmail> {
      required(message.idempotencyKey, "idempotency key");
      const result = await options.client.send(new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [required(message.to, "recipient")] },
        ...(replyTo === null ? {} : { ReplyToAddresses: [replyTo] }),
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: message.text, Charset: "UTF-8" },
              Html: { Data: message.html, Charset: "UTF-8" },
            },
          },
        },
        ...(message.tags === undefined ? {} : {
          EmailTags: message.tags.map((tag) => ({ Name: tagPart(tag.name), Value: tagPart(tag.value) })),
        }),
      }));
      const id = result.MessageId;
      if (typeof id !== "string" || id === "") throw new Error("SES send returned no message id");
      return { id };
    },
  };
}
