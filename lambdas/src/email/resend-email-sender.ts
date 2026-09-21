import type { EmailSender, SentEmail, TransactionalEmail } from "./email-sender.ts";

type Fetch = typeof fetch;

export type ResendEmailSenderOptions = Readonly<{
  apiKey: string;
  from: string;
  replyTo?: string | null;
  endpoint?: string;
  fetch?: Fetch;
}>;

function required(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || /[\r\n]/.test(trimmed)) throw new Error(`invalid Resend ${name}`);
  return trimmed;
}

function errorBody(value: string): string {
  return value.replaceAll(/\s+/g, " ").slice(0, 500);
}

export function createResendEmailSender(options: ResendEmailSenderOptions): EmailSender {
  const apiKey = required(options.apiKey, "API key");
  const from = required(options.from, "from address");
  const replyTo = options.replyTo === undefined || options.replyTo === null || options.replyTo.trim() === ""
    ? null
    : required(options.replyTo, "reply-to address");
  const endpoint = options.endpoint ?? "https://api.resend.com/emails";
  const request = options.fetch ?? fetch;

  return {
    async send(message: TransactionalEmail): Promise<SentEmail> {
      const response = await request(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "idempotency-key": required(message.idempotencyKey, "idempotency key"),
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(replyTo === null ? {} : { reply_to: replyTo }),
          ...(message.tags === undefined ? {} : { tags: message.tags }),
        }),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`Resend send failed (${response.status}): ${errorBody(body)}`);
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { throw new Error("Resend send returned invalid JSON"); }
      const id = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>).id : undefined;
      if (typeof id !== "string" || id === "") throw new Error("Resend send returned no email id");
      return { id };
    },
  };
}
