import { AddressInfo } from 'node:net';
// smtp-server ships without types; the surface used here is small.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SMTPServer } = require('smtp-server') as { SMTPServer: new (opts: Record<string, unknown>) => SmtpServerLike };

interface SmtpServerLike {
  listen(port: number, host: string, cb: () => void): void;
  close(cb: () => void): void;
  server: { address(): AddressInfo };
}

export interface ReceivedMail {
  to: string[];
  raw: string;
  messageId: string | null;
}

/**
 * A real SMTP server (nodemailer's smtp-server) on localhost, with STARTTLS (self-signed certificate) like a
 * provider's submission port. `respond` decides each delivery: accept, temporary (4xx) or permanent (5xx) rejection.
 * Used to exercise the production SMTP transport end to end — it is not evidence that a real provider works.
 */
export async function startSmtpServer(port = 0) {
  const received: ReceivedMail[] = [];
  const state = { respond: (): 'ok' | 'temporary' | 'permanent' => 'ok' };
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['AUTH'],
    logger: false,
    onData(stream: NodeJS.ReadableStream & { sizeExceeded?: boolean }, session: { envelope: { rcptTo: { address: string }[] } }, cb: (err?: Error & { responseCode?: number }) => void) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const mode = state.respond();
        if (mode === 'temporary') return cb(Object.assign(new Error('Mailbox temporarily unavailable, try later'), { responseCode: 451 }));
        if (mode === 'permanent') return cb(Object.assign(new Error('No such user here'), { responseCode: 550 }));
        const raw = Buffer.concat(chunks).toString();
        received.push({ to: session.envelope.rcptTo.map((r) => r.address), raw, messageId: /^Message-ID:\s*(.+)$/im.exec(raw)?.[1]?.trim() ?? null });
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return {
    port: server.server.address().port,
    received,
    state,
    close: () => new Promise<void>((r) => server.close(r)),
  };
}
