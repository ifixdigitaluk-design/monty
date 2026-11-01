import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  ActivityInput,
  ActivitySchema,
  CompanyInput,
  CompanySchema,
  ContactInput,
  ContactSchema,
  DealInput,
  DealSchema,
  QuoteInput,
  QuoteSchema,
  UpdateActivityInput,
  UpdateActivitySchema,
  UpdateCompanyInput,
  UpdateCompanySchema,
  UpdateContactInput,
  UpdateContactSchema,
  UpdateDealInput,
  UpdateDealSchema,
  UpdateQuoteInput,
  UpdateQuoteSchema,
} from '@monty/validation';
import { DEAL_STAGES } from '@monty/domain';
import { Auth, AuthContext } from '../common/auth-context';
import { UuidPipe, ZodPipe } from '../common/pipes';
import { CrmService } from './crm.service';

const UUID = /^[0-9a-f-]{36}$/i;
const id = (v?: string) => (v && UUID.test(v) ? v : undefined);
const q = (v?: string) => (typeof v === 'string' && v.trim() ? v.slice(0, 200) : undefined);

@Controller()
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  @Get('workspaces/:ws/crm/summary')
  summary(@Auth() a: AuthContext, @Param('ws', UuidPipe) ws: string) {
    return this.crm.summary(a.userId, ws);
  }

  // companies
  @Get('workspaces/:ws/crm/companies')
  async companies(@Auth() a: AuthContext, @Param('ws', UuidPipe) ws: string, @Query('q') query?: string) {
    return { companies: await this.crm.listCompanies(a.userId, ws, q(query)) };
  }
  @Post('workspaces/:ws/crm/companies')
  async createCompany(@Auth() a: AuthContext, @Param('ws', UuidPipe) ws: string, @Body(new ZodPipe(CompanySchema)) b: CompanyInput, @Res({ passthrough: true }) res: Response) {
    const { company, created } = await this.crm.createCompany(a.userId, ws, b);
    res.status(created ? 201 : 200);
    return { company };
  }
  @Get('crm/companies/:id')
  getCompany(@Auth() a: AuthContext, @Param('id', UuidPipe) cid: string) {
    return this.crm.getCompany(a.userId, cid);
  }
  @Patch('crm/companies/:id')
  async updateCompany(@Auth() a: AuthContext, @Param('id', UuidPipe) cid: string, @Body(new ZodPipe(UpdateCompanySchema)) b: UpdateCompanyInput) {
    return { company: await this.crm.updateCompany(a.userId, cid, b) };
  }
  @Delete('crm/companies/:id')
  @HttpCode(204)
  async removeCompany(@Auth() a: AuthContext, @Param('id', UuidPipe) cid: string) {
    await this.crm.removeCompany(a.userId, cid);
  }

  // contacts
  @Get('workspaces/:ws/crm/contacts')
  async contacts(@Auth() a: AuthContext, @Param('ws', UuidPipe) ws: string, @Query('q') query?: string, @Query('companyId') companyId?: string) {
    return { contacts: await this.crm.listContacts(a.userId, ws, { q: q(query), companyId: id(companyId) }) };
  }
  @Post('workspaces/:ws/crm/contacts')
  async createContact(@Auth() a: AuthContext, @Param('ws', UuidPipe) ws: string, @Body(new ZodPipe(ContactSchema)) b: ContactInput, @Res({ passthrough: true }) res: Response) {
    const { contact, created } = await this.crm.createContact(a.userId, ws, b);
    res.status(created ? 201 : 200);
    return { contact };
  }
  @Get('crm/contacts/:id')
  getContact(@Auth() a: AuthContext, @Param('id', UuidPipe) cid: string) {
    return this.crm.getContact(a.userId, cid);
  }
  @Patch('crm/contacts/:id')
  async updateContact(@Auth() a: AuthContext, @Param('id', UuidPipe) cid: string, @Body(new ZodPipe(UpdateContactSchema)) b: UpdateContactInput) {
    return { contact: await this.crm.updateContact(a.userId, cid, b) };
  }
  @Delete('crm/contacts/:id')
  @HttpCode(204)
  async removeContact(@Auth() a: AuthContext, @Param('id', UuidPipe) cid: string) {
    await this.crm.removeContact(a.userId, cid);
  }

  // deals
  @Get('workspaces/:ws/crm/deals')
  async deals(@Auth() a: AuthContext, @Param('ws', UuidPipe) ws: string, @Query('q') query?: string, @Query('stage') stage?: string) {
    return { deals: await this.crm.listDeals(a.userId, ws, { q: q(query), stage: (DEAL_STAGES as readonly string[]).includes(stage ?? '') ? stage : undefined }) };
  }
  @Post('workspaces/:ws/crm/deals')
  async createDeal(@Auth() a: AuthContext, @Param('ws', UuidPipe) ws: string, @Body(new ZodPipe(DealSchema)) b: DealInput, @Res({ passthrough: true }) res: Response) {
    const { deal, created } = await this.crm.createDeal(a.userId, ws, b);
    res.status(created ? 201 : 200);
    return { deal };
  }
  @Get('crm/deals/:id')
  getDeal(@Auth() a: AuthContext, @Param('id', UuidPipe) did: string) {
    return this.crm.getDeal(a.userId, did);
  }
  @Patch('crm/deals/:id')
  async updateDeal(@Auth() a: AuthContext, @Param('id', UuidPipe) did: string, @Body(new ZodPipe(UpdateDealSchema)) b: UpdateDealInput) {
    return { deal: await this.crm.updateDeal(a.userId, did, b) };
  }
  @Delete('crm/deals/:id')
  @HttpCode(204)
  async removeDeal(@Auth() a: AuthContext, @Param('id', UuidPipe) did: string) {
    await this.crm.removeDeal(a.userId, did);
  }

  // activities & follow-ups
  @Get('workspaces/:ws/crm/activities')
  async activities(@Auth() a: AuthContext, @Param('ws', UuidPipe) ws: string, @Query('mine') mine?: string, @Query('open') open?: string) {
    return { activities: await this.crm.activities(a.userId, ws, { mine: mine === '1', open: open === '1' }) };
  }
  @Post('workspaces/:ws/crm/activities')
  async createActivity(@Auth() a: AuthContext, @Param('ws', UuidPipe) ws: string, @Body(new ZodPipe(ActivitySchema)) b: ActivityInput) {
    return { activity: await this.crm.createActivity(a.userId, ws, b) };
  }
  @Patch('crm/activities/:id')
  async updateActivity(@Auth() a: AuthContext, @Param('id', UuidPipe) aid: string, @Body(new ZodPipe(UpdateActivitySchema)) b: UpdateActivityInput) {
    return { activity: await this.crm.updateActivity(a.userId, aid, b) };
  }
  @Delete('crm/activities/:id')
  @HttpCode(204)
  async removeActivity(@Auth() a: AuthContext, @Param('id', UuidPipe) aid: string) {
    await this.crm.removeActivity(a.userId, aid);
  }

  // quotes
  @Get('workspaces/:ws/crm/quotes')
  async quotes(@Auth() a: AuthContext, @Param('ws', UuidPipe) ws: string) {
    return { quotes: await this.crm.listQuotes(a.userId, ws) };
  }
  @Post('workspaces/:ws/crm/quotes')
  async createQuote(@Auth() a: AuthContext, @Param('ws', UuidPipe) ws: string, @Body(new ZodPipe(QuoteSchema)) b: QuoteInput, @Res({ passthrough: true }) res: Response) {
    const { quote, created } = await this.crm.createQuote(a.userId, ws, b);
    res.status(created ? 201 : 200);
    return { quote };
  }
  @Get('crm/quotes/:id')
  async getQuote(@Auth() a: AuthContext, @Param('id', UuidPipe) qid: string) {
    return { quote: await this.crm.getQuote(a.userId, qid) };
  }
  @Patch('crm/quotes/:id')
  async updateQuote(@Auth() a: AuthContext, @Param('id', UuidPipe) qid: string, @Body(new ZodPipe(UpdateQuoteSchema)) b: UpdateQuoteInput) {
    return { quote: await this.crm.updateQuote(a.userId, qid, b) };
  }
  @Delete('crm/quotes/:id')
  @HttpCode(204)
  async removeQuote(@Auth() a: AuthContext, @Param('id', UuidPipe) qid: string) {
    await this.crm.removeQuote(a.userId, qid);
  }
}
