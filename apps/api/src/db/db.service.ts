import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { createDb, Database, DbHandle } from '@monty/database';
import { AppConfig, CONFIG } from '../config';

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly handle: DbHandle;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.handle = createDb(config.databaseUrl);
  }

  get db(): Database {
    return this.handle.db;
  }

  async onModuleDestroy() {
    await this.handle.close();
  }
}

@Global()
@Module({ providers: [DbService], exports: [DbService] })
export class DbModule {}
