import { Controller, Get, Inject, Injectable, Logger, Query } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { Public } from '../common/auth-context';
import { notFound } from '../common/errors';
import { LogTransport, MailMessage, MailTransport, SmtpTransport } from './transports';

@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  readonly transport: MailTransport;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.transport =
      config.mail.transport === 'smtp' && config.mail.smtp ? new SmtpTransport(config.mail.smtp) : new LogTransport();
  }

  /** Absolute link into the web app. */
  link(pathWithQuery: string): string {
    return `${this.config.appUrl}${pathWithQuery}`;
  }

  /**
   * Sends and reports success. Never throws: callers decide whether a failure matters to the user.
   * Logs recipient domain and kind only — never the link (it contains a secret token).
   */
  async send(message: MailMessage): Promise<boolean> {
    try {
      await this.transport.send(this.config.mail.from, message);
      this.logger.log(JSON.stringify({ msg: 'mail_sent', kind: message.kind, toDomain: message.to.split('@')[1], transport: this.transport.name }));
      return true;
    } catch (err) {
      this.logger.error(JSON.stringify({ msg: 'mail_failed', kind: message.kind, toDomain: message.to.split('@')[1], error: String(err) }));
      return false;
    }
  }
}

/**
 * Development-only mailbox so developers and end-to-end tests can read emails without a real provider.
 * Only registered when MAIL_TRANSPORT=log and NODE_ENV is not production (see AppModule), and it re-checks both here.
 */
@Controller('dev/mailbox')
export class DevMailboxController {
  constructor(
    private readonly mail: MailService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get()
  list(@Query('to') to?: string) {
    if (this.config.isProduction || !(this.mail.transport instanceof LogTransport)) throw notFound();
    return { messages: this.mail.transport.messages(to) };
  }
}
