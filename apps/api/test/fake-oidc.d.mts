export interface FakeOidc {
  issuer: string;
  clientId: string;
  clientSecret: string;
  stats: { tokenRequests: number };
  close: () => Promise<void>;
}
export function startFakeOidc(opts?: { port?: number; clientId?: string; clientSecret?: string }): Promise<FakeOidc>;
