import { createHmac } from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

/**
 * Outbound webhooks with SSRF protection:
 * - HTTPS only, no redirects followed, 5 s timeout, response body discarded.
 * - The destination address is checked at connect time (custom DNS lookup), so a hostname that resolves to a
 *   private, loopback, link-local or otherwise non-public address is refused — including DNS-rebinding attempts,
 *   because the address that is checked is the address that is connected to.
 */
const blocked = new net.BlockList();
for (const [net4, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net4, prefix, 'ipv4');
for (const [net6, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]] as const) {
  blocked.addSubnet(net6, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return blocked.check(mapped[1]!, 'ipv4');
  const family = net.isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) return blocked.check(ip, 'ipv6');
  return true; // not an IP at all: refuse
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

export function safeLookup(hostname: string, options: dns.LookupOptions, cb: LookupCb) {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return cb(err, '');
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      return cb(Object.assign(new Error('Webhook host resolves to a non-public address'), { code: 'EBLOCKED' }), '');
    }
    if (options.all) return cb(null, list);
    return cb(null, list[0]!.address, list[0]!.family);
  });
}

export function signature(secret: string, timestamp: number, body: string) {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export type WebhookSender = (url: string, body: string, secret: string) => Promise<{ status: number }>;

export const sendWebhook: WebhookSender = (url, body, secret) =>
  new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error('Invalid webhook URL'));
    }
    if (u.protocol !== 'https:') return reject(new Error('Webhook URL must use https'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateAddress(host)) return reject(new Error('Webhook host is a non-public address'));
    const ts = Math.floor(Date.now() / 1000);
    const req = https.request(
      {
        hostname: host,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        timeout: 5_000,
        lookup: safeLookup as unknown as typeof dns.lookup,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'Monty-Webhooks/1',
          'x-monty-signature': signature(secret, ts, body),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve({ status });
          else reject(new Error(`Webhook returned HTTP ${status}`));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Webhook timed out after 5 seconds')));
    req.on('error', reject);
    req.end(body);
  });
