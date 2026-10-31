/**
 * Provider-neutral mail transport. SMTP works with Postmark, Resend, Amazon SES, Mailgun and others,
 * so the email provider is a configuration choice, not a code change.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Machine-readable kind, e.g. 'password_reset' (used in logs and the dev mailbox; never sent). */
  kind: string;
}

export interface MailTransport {
  readonly name: string;
  send(from: string, message: MailMessage): Promise<void>;
}

/** Development/test transport: keeps messages in memory (bounded) so they can be inspected. Never used in production. */
export class LogTransport implements MailTransport {
  readonly name = 'log';
  private readonly sent: (MailMessage & { from: string; sentAt: string })[] = [];

  async send(from: string, message: MailMessage): Promise<void> {
    this.sent.push({ ...message, from, sentAt: new Date().toISOString() });
    if (this.sent.length > 200) this.sent.shift();
  }

  messages(to?: string) {
    return to ? this.sent.filter((m) => m.to === to.toLowerCase()) : [...this.sent];
  }

  clear() {
    this.sent.length = 0;
  }
}

/** Minimal surface of nodemailer we rely on (nodemailer 9 ships without bundled types). */
interface SmtpClient {
  sendMail(opts: { from: string; to: string; subject: string; text: string; html: string }): Promise<unknown>;
}

export class SmtpTransport implements MailTransport {
  readonly name = 'smtp';
  private readonly client: SmtpClient;

  constructor(opts: { host: string; port: number; secure: boolean; user?: string; pass?: string }) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodemailer = require('nodemailer') as { createTransport(o: unknown): SmtpClient };
    this.client = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      requireTLS: !opts.secure, // STARTTLS on 587; never send credentials or links in clear text
      auth: opts.user ? { user: opts.user, pass: opts.pass } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(from: string, m: MailMessage): Promise<void> {
    await this.client.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html });
  }
}
