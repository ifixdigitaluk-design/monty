import { Controller, Get, Query } from '@nestjs/common';
import { todayUtc } from '@monty/domain';
import { CalendarQuerySchema, SearchQuerySchema, TodayQuerySchema } from '@monty/validation';
import { Throttle } from '@nestjs/throttler';
import { Auth, AuthContext } from '../common/auth-context';
import { ZodPipe } from '../common/pipes';
import { InsightsService } from './insights.service';

@Controller()
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('search')
  async search(@Auth() a: AuthContext, @Query(new ZodPipe(SearchQuerySchema)) q: { q: string; limit?: number }) {
    return { results: await this.insights.search(a.userId, q.q, q.limit) };
  }

  @Get('calendar')
  async calendar(@Auth() a: AuthContext, @Query(new ZodPipe(CalendarQuerySchema)) q: { from: string; to: string; mine?: '1' | '0' }) {
    return { entries: await this.insights.calendar(a.userId, q.from, q.to, q.mine === '1') };
  }

  @Get('me/home')
  async home(@Auth() a: AuthContext, @Query(new ZodPipe(TodayQuerySchema)) q: { today?: string }) {
    return this.insights.home(a.userId, q.today ?? todayUtc());
  }
}
