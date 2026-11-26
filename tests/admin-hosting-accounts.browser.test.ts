import { afterAll, expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';
import { config } from '../src/config';
import { buildAdminInterfaceHtml } from '../src/openapi';

// Real rendered Chromium page of the existing /admin UI with a disposable NIP-07 key.
// HTTP authority is a fixture; no request reaches a real Tower and no real owner key is used.
const savedDirectUrl = config.directHttpsUrl;
config.directHttpsUrl = '';
afterAll(() => { config.directHttpsUrl = savedDirectUrl; });

const account = (n: number, extra: Record<string, unknown> = {}) => ({
  account_id: `00000000-0000-4000-8000-00000000000${n}`, owner_npub: `npub1fixture${n}`.padEnd(40, 'x'), owner_label: null, opened_by: 'onboarding', created_at: '2026-11-26T01:00:00.000Z',
  purchased_units: '0', purchased_usd: '0.000000000000', promo_units: '0', promo_usd: '0.000000000000', promo_expires_at: '2026-11-26T01:00:00.000Z',
  reversal_debt_units: '0', reversal_debt_usd: '0.000000000000', balance_units: '0', balance_usd: '0.000000000000',
  workspaces: { count: 0, names: [] }, latest_onboarding: null, ...extra,
});
const page = (accounts: any[], extra: Record<string, unknown> = {}) => ({
  viewer: 'fixture', version: 1, refreshed_at: '2026-11-26T02:00:00.000Z', build: { git_commit: 'abcdef1234567890', git_branch: 'main', build_time: null, version: null },
  providers: { onboarding_enabled: false, card: { available: false, mode: 'test', live_rollout_blocked: true }, lightning: { available: false } },
  total: accounts.length, limit: 25, offset: 0, has_more: false, accounts, ...extra,
});

async function run(scenario: 'list' | 'empty' | 'error' | 'open' | 'identity-change' | 'logout-race' | 'rejected' | 'sign-logout' | 'sign-reconnect' | 'sign-identity-swap') {
  const key = generateSecretKey(), pubkey = getPublicKey(key), npub = nip19.npubEncode(pubkey);
  const reads: string[] = [], posts: { raw: string; event: any }[] = [];
  let accounts: any[] = scenario === 'list' ? [
    account(1, { owner_label: '<img src=x onerror=window.__pwned=1>', purchased_units: '21', purchased_usd: '21.000000000000', balance_usd: '21.000000000000', workspaces: { count: 7, names: ['A', 'B', 'C', 'D', 'E'] },
      reversal_debt_units: '5', reversal_debt_usd: '5.123456789012', latest_onboarding: { status: 'funded', funding_cents: 2100, created_at: '2026-11-26T00:00:00.000Z', updated_at: '2026-11-26T01:30:00.000Z', provisioned_at: null, last_error: 'workspace:storage_unavailable' } }),
    account(2),
  ] : [];
  let releaseSlow: (() => void) | undefined;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/admin') return new Response(buildAdminInterfaceHtml(url.origin), { headers: { 'content-type': 'text/html' } });
    const event = JSON.parse(Buffer.from((req.headers.get('authorization') || '').replace('Nostr ', ''), 'base64').toString());
    expect(verifyEvent(event)).toBe(true);
    expect(event.tags).toContainEqual(['u', req.url]); expect(event.tags).toContainEqual(['method', req.method]);
    if (url.pathname === '/api/v4/admin/tables') return Response.json({ tables: [] });
    if (url.pathname === '/api/v4/admin/workspaces') return Response.json({ workspaces: [] });
    if (url.pathname === '/api/v4/admin/tower') return Response.json({ tower_name: 'T', tower_description: '' });
    if (url.pathname === '/api/v4/admin/hosting-accounts' && req.method === 'GET') {
      reads.push(url.search);
      if (scenario === 'error') return Response.json({ error: 'database unavailable' }, { status: 503 });
      if (scenario === 'logout-race' && reads.length === 2) await new Promise<void>((resolve) => { releaseSlow = resolve; });
      return Response.json(page(accounts));
    }
    if (url.pathname === '/api/v4/onboarding/account' && req.method === 'POST') {
      const raw = await req.text();
      posts.push({ raw, event });
      expect(event.pubkey).toBe(pubkey);
      accounts = [account(3, { owner_npub: npub, opened_by: 'onboarding' })];
      return Response.json({ account: { account_id: accounts[0].account_id, currency: 'USD', balance_units: '0', balance_usd: '0.000000000000' } });
    }
    return new Response('', { status: 404 });
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    const tab = await browser.newPage();
    await tab.exposeFunction('fixtureSign', (e: any) => finalizeEvent(e, key));
    await tab.route('https://esm.sh/**', (route) => route.fulfill({ contentType: 'text/javascript', body: `export const npubEncode = () => ${JSON.stringify(npub)};` }));
    await tab.addInitScript(({ pubkey, scenario }) => {
      (window as any).__signs = 0;
      (window as any).nostr = {
        getPublicKey: async () => ((window as any).__identity ?? pubkey),
        signEvent: async (e: any) => {
          if (scenario === 'rejected' && e.tags.some((t: string[]) => t[0] === 'payload')) throw new Error('Signer declined');
          (window as any).__signs++;
          if (scenario.startsWith('sign-') && e.tags.some((t: string[]) => t[0] === 'payload')) {
            // Hold each strict signature until the test releases it, so session changes can happen mid-signing.
            await new Promise<void>((resolve) => { ((window as any).__held ??= []).push(resolve); });
          }
          return (window as any).fixtureSign(e);
        },
      };
    }, { pubkey, scenario });
    await tab.goto(`http://127.0.0.1:${server.port}/admin`);
    await tab.locator('#connectBtn').click();
    await tab.locator('[data-view="hosting"]').click();
    const data = tab.locator('#hostingData');

    if (scenario === 'list') {
      await tab.locator('#hostingData tbody tr').first().waitFor();
      expect(await tab.locator('#hostingData tbody tr').count()).toBe(2);
      expect(await tab.evaluate(() => (window as any).__pwned)).toBeUndefined(); // owner label is rendered as text, never HTML
      const text = (await data.textContent())!;
      expect(text).toContain('<img src=x onerror=window.__pwned=1>');
      expect(text).toContain('$21.0000'); expect(text).toContain('$5.1234'); expect(text).toContain('funded'); expect(text).toContain('workspace:storage_unavailable');
      expect(text).toContain('A, B, C, D, E, ...');
      expect(await tab.locator('#hostingMeta').textContent()).toContain('abcdef123456');
      expect(await tab.locator('#hostingProviders').textContent()).toContain('Onboarding rollout: disabled');
      expect(reads[0]).toBe('?limit=25&offset=0');
      expect(await tab.locator('#prevHostingBtn').isDisabled()).toBe(true);
      expect(await tab.locator('#nextHostingBtn').isDisabled()).toBe(true);
    }
    if (scenario === 'empty') {
      await data.getByText('No hosting accounts exist yet.').waitFor();
      expect(await tab.locator('#hostingData tbody tr').count()).toBe(0);
    }
    if (scenario === 'error') {
      await data.getByText('Could not load hosting accounts: database unavailable').waitFor();
      expect(await tab.locator('#hostingData tbody tr').count()).toBe(0);
    }
    if (scenario === 'open') {
      await data.getByText('No hosting accounts exist yet.').waitFor();
      await tab.locator('#openHostingAccountBtn').click();
      await tab.locator('#hostingData tbody tr').first().waitFor();
      expect(posts.length).toBe(1);
      expect(posts[0]!.raw).toBe('');
      expect(posts[0]!.event.tags).toContainEqual(['payload', createHash('sha256').update('').digest('hex')]);
      expect(await tab.locator('#status').textContent()).toContain('No credit, checkout or paid agent was started');
      expect(await tab.locator('#hostingData').textContent()).toContain('onboarding');
      expect(await tab.locator('#openHostingAccountBtn').isEnabled()).toBe(true);
    }
    if (scenario === 'identity-change') {
      await data.getByText('No hosting accounts exist yet.').waitFor();
      await tab.evaluate(() => { (window as any).__identity = '1'.repeat(64); });
      const signsBefore = await tab.evaluate(() => (window as any).__signs);
      await tab.locator('#openHostingAccountBtn').click();
      await tab.getByText('Nostr identity changed since connecting').waitFor();
      expect(posts.length).toBe(0);
      expect(await tab.evaluate(() => (window as any).__signs)).toBe(signsBefore);
      expect(await tab.locator('#openHostingAccountBtn').isEnabled()).toBe(true);
    }
    if (scenario === 'rejected') {
      await data.getByText('No hosting accounts exist yet.').waitFor();
      await tab.locator('#openHostingAccountBtn').click();
      await tab.getByText('Signer declined').waitFor();
      expect(posts.length).toBe(0);
    }
    if (scenario.startsWith('sign-')) {
      await data.getByText('No hosting accounts exist yet.').waitFor();
      const held = () => tab.evaluate(() => ((window as any).__held ?? []).length);
      const release = (i: number) => tab.evaluate((n) => (window as any).__held[n](), i);
      await tab.locator('#openHostingAccountBtn').click();
      for (let i = 0; i < 100 && (await held()) < 1; i++) await tab.waitForTimeout(25);
      expect(await held()).toBe(1);
      expect(await tab.locator('#openHostingAccountBtn').isDisabled()).toBe(true);
      await tab.locator('#logoutBtn').click();
      if (scenario === 'sign-logout') {
        await release(0);
        await tab.waitForTimeout(250);
        expect(posts.length).toBe(0);
        expect(await tab.locator('#openHostingAccountBtn').isEnabled()).toBe(true);
      } else {
        if (scenario === 'sign-identity-swap') await tab.evaluate(() => { (window as any).__identity = '1'.repeat(64); });
        await tab.locator('#connectBtn').click();
        await data.getByText('No hosting accounts exist yet.').waitFor();
        if (scenario === 'sign-reconnect') {
          // The new session starts its own action; the old action finishing must not re-enable its busy button.
          await tab.locator('#openHostingAccountBtn').click();
          for (let i = 0; i < 100 && (await held()) < 2; i++) await tab.waitForTimeout(25);
          expect(await held()).toBe(2);
          await release(0);
          await tab.waitForTimeout(250);
          expect(posts.length).toBe(0);
          expect(await tab.locator('#openHostingAccountBtn').isDisabled()).toBe(true);
          await release(1);
          await tab.locator('#hostingData tbody tr').first().waitFor();
          expect(posts.length).toBe(1);
        } else {
          await release(0);
          await tab.waitForTimeout(250);
          expect(posts.length).toBe(0);
        }
      }
    }
    if (scenario === 'logout-race') {
      await data.getByText('No hosting accounts exist yet.').waitFor();
      accounts = [account(4)];
      await tab.locator('#refreshHostingBtn').click();
      for (let i = 0; i < 100 && reads.length < 2; i++) await tab.waitForTimeout(50);
      expect(reads.length).toBe(2);
      await tab.locator('#logoutBtn').click();
      releaseSlow!();
      await tab.waitForTimeout(250);
      // The late response belongs to the ended session and must not repopulate the view.
      expect(await tab.locator('#hostingData tbody tr').count()).toBe(0);
      expect(await data.textContent()).toContain('Connect to load hosting accounts.');
      expect(await tab.locator('#hostingMeta').textContent()).toBe('');
    }
  } finally { await browser.close(); server.stop(true); }
}

for (const scenario of ['list', 'empty', 'error', 'open', 'identity-change', 'rejected', 'logout-race', 'sign-logout', 'sign-reconnect', 'sign-identity-swap'] as const)
  test(`admin hosting accounts view: ${scenario}`, () => run(scenario), 30000);
