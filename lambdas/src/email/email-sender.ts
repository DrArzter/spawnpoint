export type TransactionalEmail = Readonly<{
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
  tags?: readonly Readonly<{ name: string; value: string }>[];
}>;

export type SentEmail = Readonly<{ id: string }>;

// Transactional email is a delivery port. Domain code chooses what the
// message means; an installation chooses whether Resend, another provider or
// no email adapter carries it.
export interface EmailSender {
  send(message: TransactionalEmail): Promise<SentEmail>;
}
