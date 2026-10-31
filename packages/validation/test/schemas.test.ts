import { describe, expect, it } from 'vitest';
import { CreateTaskSchema, RegisterSchema, UpdateProjectSchema, UpdateTaskSchema } from '../src';

describe('validation schemas', () => {
  it('normalises email to lower case', () => {
    const r = RegisterSchema.parse({ email: 'Ana@Example.COM', name: 'Ana', password: 'correct-horse' });
    expect(r.email).toBe('ana@example.com');
  });
  it('rejects short passwords', () => {
    expect(RegisterSchema.safeParse({ email: 'a@b.co', name: 'A', password: 'short' }).success).toBe(false);
  });
  it('rejects unknown fields (mass-assignment protection)', () => {
    expect(CreateTaskSchema.safeParse({ title: 'x', organisationId: 'evil' }).success).toBe(false);
  });
  it('requires expectedVersion on updates', () => {
    expect(UpdateTaskSchema.safeParse({ title: 'x' }).success).toBe(false);
    expect(UpdateTaskSchema.safeParse({ title: 'x', expectedVersion: 1 }).success).toBe(true);
  });
  it('rejects invalid calendar dates', () => {
    expect(CreateTaskSchema.safeParse({ title: 'x', dueDate: '2026-02-30' }).success).toBe(false);
  });
  it('rejects start after target', () => {
    expect(
      UpdateProjectSchema.safeParse({ expectedVersion: 1, startDate: '2026-12-02', targetDate: '2026-12-01' }).success,
    ).toBe(false);
  });
});
