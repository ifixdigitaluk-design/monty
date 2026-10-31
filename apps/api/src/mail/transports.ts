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

export interface SendOptions {
  /** Stable Message-ID so a resend after a crash can be recognised as the same message by providers and clients. */
  messageId?: string;
}

export interface MailTransport {
  readonly name: string;
  send(from: string, message: MailMessage, opts?: SendOptions): Promise<void>;
}

/** Thrown/wrapped errors are classified so the queue knows whether retrying can help. */
export type FailureKind = 'temporary' | 'permanent';

export function classifySendError(err: unknown): { kind: FailureKind; smtpCode: number | null; message: string } {
  const e = err as { responseCode?: number; code?: string; message?: string };
  const smtpCode = typeof e?.responseCode === 'number' ? e.responseCode : null;
  // Never keep the full provider response: it can echo the message. Keep code + a short reason.
  const message = `${e?.code ?? 'ERROR'}${smtpCode ? ` ${smtpCode}` : ''}: ${String(e?.message ?? err).replace(/\s+/g, ' ').slice(0, 200)}`;
  // RFC 5321: 5yz = permanent negative completion (bad mailbox, rejected content). 4yz = transient.
  // Authentication failures (535) are a configuration problem that operators can fix, so keep retrying them.
  if (smtpCode !== null && smtpCode >= 500 && smtpCode < 600 && smtpCode !== 535) return { kind: 'permanent', smtpCode, message };
  return { kind: 'temporary', smtpCode, message };
}

/** Development/test transport: keeps messages in memory (bounded) so they can be inspected. Never used in production. */
export class LogTransport implements MailTransport {
  readonly name = 'log';
  private readonly sent: (MailMessage & { from: string; sentAt: string; messageId?: string })[] = [];

  /** Test hook: make the next N sends fail with the given error. */
  failures: Error[] = [];

  async send(from: string, message: MailMessage, opts: SendOptions = {}): Promise<void> {
    const failure = this.failures.shift();
    if (failure) throw failure;
    if (opts.messageId && this.sent.some((m) => m.messageId === opts.messageId)) return; // same message re-sent after a crash
    this.sent.push({ ...message, from, sentAt: new Date().toISOString(), messageId: opts.messageId });
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
  sendMail(opts: { from: string; to: string; subject: string; text: string; html: string; messageId?: string }): Promise<unknown>;
  close(): void;
}

export class SmtpTransport implements MailTransport {
  readonly name = 'smtp';
  private readonly client: SmtpClient;

  constructor(opts: { host: string; port: number; secure: boolean; user?: string; pass?: string; rejectUnauthorized?: boolean }) {
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
      tls: { rejectUnauthorized: opts.rejectUnauthorized ?? true },
    });
  }

  async send(from: string, m: MailMessage, opts: SendOptions = {}): Promise<void> {
    await this.client.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html, messageId: opts.messageId });
  }

  close() {
    this.client.close();
  }
}
