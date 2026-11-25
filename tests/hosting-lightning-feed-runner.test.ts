import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { closeDb, setDb } from '../src/db';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { FEED_RUNNER_LIMITS, createFeedRunner, feedAttention, type FeedRunnerClock } from '../src/services/hosting-lightning-feed-runner';
import type { LightningProvider } from '../src/services/hosting-lightning';
import { createReceiverLightningProvider } from '../src/services/lightning-receiver-client';
import { FakeMintReceiver } from './helpers/fake-mint-receiver';

// Runs only against a dedicated disposable PostgreSQL: FEEDRUN_TEST_PORT=<free port>.
const port = Number(process.env.FEEDRUN_TEST_PORT);

/** Manual clock: timers fire only when the test advances time. */
class FakeClock implements FeedRunnerClock {
  t = 1_000_000; timers = new Map<number, { at: number; fn: () => void }>(); n = 0;
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.n; this.timers.set(id, { at: this.t + ms, fn }); return id; }
  clearTimeout(h: unknown) { this.timers.delete(h as number); }
  pending() { return [...this.timers.values()].map(x => x.at - this.t).sort((a, b) => a - b); }
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]); this.t = Math.max(this.t, due[1].at); due[1].fn();
      for (let i = 0; i < 40; i++) await Promise.resolve();
      await new Promise(r => setTimeout(r, 15));
    }
    this.t = end;
  }
}
const tick = () => new Promise(r => setTimeout(r, 25));

describe('feed runner is inert unless trusted startup enables a mint-backed provider (no database needed)', () => {
  const rx = new FakeMintReceiver();
  test('disabled by default and for unsupported providers; start() schedules nothing', async () => {
    const clock = new FakeClock();
    const off = createFeedRunner({ enabled: false, provider: createReceiverLightningProvider(rx, rx.expectation), clock });
    expect(await off.runOnce()).toEqual({ status: 'disabled' }); off.start(); expect(clock.pending()).toEqual([]);
    const none = createFeedRunner({ enabled: true, provider: null, clock });
    expect(await none.runOnce()).toEqual({ status: 'unconfigured' }); none.start(); expect(clock.pending()).toEqual([]);
    const preimage: LightningProvider = { id: 'p', payeeRef: 'x', issueInvoice: async () => { throw new Error('no'); }, lookupInvoice: async () => { throw new Error('no'); } };
    const wrong = createFeedRunner({ enabled: true, provider: preimage, clock });
    expect(await wrong.runOnce()).toEqual({ status: 'unconfigured' }); wrong.start(); expect(clock.pending()).toEqual([]);
    const noFeed = createFeedRunner({ enabled: true, provider: { ...createReceiverLightningProvider(rx, rx.expectation), bindingsPage: undefined }, clock });
    expect(await noFeed.runOnce()).toEqual({ status: 'unconfigured' });
  });
  test('attention classification covers every non-clean report field', () => {
    const base = { verified_through_seq: 1, head_seq: 1, head_count: 1, verified: 0, orphans: 0, conflicts: 0, gap: false, behind: false, quotes_without_binding: [] as string[] };
    expect(feedAttention(base)).toEqual([]);
    expect(feedAttention({ ...base, gap: true, conflicts: 1, orphans: 2, behind: true, quotes_without_binding: ['q'] })).toEqual(['gap', 'conflicts', 'orphans', 'behind', 'quotes_without_binding']);
  });
});

describe.skipIf(!port || port === 5432)('periodic receiver feed runner on disposable PostgreSQL (fake receiver, fake clock)', () => {
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const name = `tower_feedrun_${process.pid}_${Date.now()}`;
  let db: ReturnType<typeof postgres>;
  const fresh = () => { const rx = new FakeMintReceiver(); return { rx, p: createReceiverLightningProvider(rx, rx.expectation) }; };
  const order = (rx: FakeMintReceiver, n: number) => Promise.all(Array.from({ length: n }, () => rx.put(randomUUID(), { currency: 'USD', amountMinor: 700 })));
  const money = async () => JSON.stringify([(await db`SELECT count(*)::int AS n FROM hosting_ledger`)[0], (await db`SELECT count(*)::int AS n FROM hosting_funding_settlements`)[0], await db`SELECT id,state FROM hosting_lightning_quotes ORDER BY id`]);
  const watermark = async (fp: string) => Number((await db`SELECT verified_through_seq FROM hosting_lightning_binding_feed WHERE treasury_fingerprint=${fp}`)[0]?.verified_through_seq ?? -1);

  beforeAll(async () => {
    const root = postgres({ ...conn, database: 'postgres' });
    await root.unsafe(`CREATE DATABASE ${name}`); await root.end();
    db = postgres({ ...conn, database: name }); setDb(db);
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
  });
  afterAll(async () => { await closeDb(); });

  test('one pass verifies the chain, records orphans, and never touches credit, ledger or quote state', async () => {
    const { rx, p } = fresh(); await order(rx, 3);
    // A well-formed record whose order reference looks like a payment claim is only ever an orphan to retain.
    await rx.put('PAID', { currency: 'USD', amountMinor: 100 }); rx.pay('PAID');
    const before = await money();
    const seen: any[] = [];
    const runner = createFeedRunner({ enabled: true, provider: p, db: db as any, clock: new FakeClock(), onReport: (r, a) => seen.push([r, a]) });
    const out = await runner.runOnce();
    expect(out).toMatchObject({ status: 'ok', report: { verified: 4, orphans: 4, conflicts: 0, gap: false, verified_through_seq: 4 } });
    expect((out as any).attention).toEqual(['orphans']);
    expect(seen.length).toBe(1);
    expect(await money()).toBe(before);
    expect(await watermark(rx.fingerprint)).toBe(4);
    expect(runner.status()).toMatchObject({ in_flight: false, consecutive_failures: 0, last_outcome: 'ok' });
  });

  test('restart-safe: a new runner resumes from the persisted watermark and a repeat pass is idempotent', async () => {
    const { rx, p } = fresh(); await order(rx, 5);
    const afters: number[] = [];
    const spy: LightningProvider = { ...p, bindingsPage: (after, limit) => { afters.push(after); return rx.bindings(after, limit); } };
    const a = createFeedRunner({ enabled: true, provider: spy, db: db as any, clock: new FakeClock(), batch: 2, maxPages: 2 });
    const first = await a.runOnce();
    expect(first).toMatchObject({ status: 'ok', report: { verified: 4, verified_through_seq: 4, behind: true } });
    expect(feedAttention((first as any).report)).toContain('behind');
    afters.length = 0; a.stop();
    const b = createFeedRunner({ enabled: true, provider: spy, db: db as any, clock: new FakeClock(), batch: 2, maxPages: 2 }); // simulated process restart
    expect(await b.runOnce()).toMatchObject({ status: 'ok', report: { verified: 1, verified_through_seq: 5, behind: false } });
    expect(afters[0]).toBe(4);
    expect(await b.runOnce()).toMatchObject({ status: 'ok', report: { verified: 0 } });
    expect((await db`SELECT count(*)::int AS n FROM hosting_lightning_binding_orphans WHERE treasury_fingerprint=${rx.fingerprint}`)[0]!.n).toBe(5);
  });

  test('no overlap in-process or across runners; the cross-process lock is released after every pass', async () => {
    const { rx, p } = fresh(); await order(rx, 2);
    let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let calls = 0;
    const slow: LightningProvider = { ...p, bindingsPage: async (after, limit) => { calls++; await gate; return rx.bindings(after, limit); } };
    const a = createFeedRunner({ enabled: true, provider: slow, db: db as any, clock: new FakeClock() });
    const other = createFeedRunner({ enabled: true, provider: p, db: db as any, clock: new FakeClock() });
    const first = a.runOnce(); await tick();
    expect(await a.runOnce()).toEqual({ status: 'overlap' });
    expect(await other.runOnce()).toEqual({ status: 'locked' });
    expect(a.status().in_flight).toBe(true);
    release(); expect(await first).toMatchObject({ status: 'ok' });
    expect(calls).toBe(1);
    expect(await other.runOnce()).toMatchObject({ status: 'ok' });
  });

  test('absolute timeout: the pass reports timeout, stops fetching further pages, and in-flight stays held until the call really settles', async () => {
    const { rx, p } = fresh(); await order(rx, 6);
    const clock = new FakeClock(); let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let calls = 0;
    const wedged: LightningProvider = { ...p, bindingsPage: async (after, limit) => { calls++; if (calls === 1) await gate; return rx.bindings(after, limit); } };
    const runner = createFeedRunner({ enabled: true, provider: wedged, db: db as any, clock, timeoutMs: 5_000, batch: 2 });
    const run = runner.runOnce(); await tick();
    await clock.advance(5_000);
    expect(await run).toEqual({ status: 'timeout', code: 'timeout' });
    expect(runner.status()).toMatchObject({ in_flight: true, consecutive_failures: 1, last_outcome: 'timeout' });
    expect(await runner.runOnce()).toEqual({ status: 'overlap' }); // wedged call is still holding the slot
    release(); await tick(); await tick();
    expect(calls).toBe(1); // aborted flag stopped any further page fetch
    expect(runner.status().in_flight).toBe(false);
    expect(await watermark(rx.fingerprint)).toBe(0); // nothing verified by the aborted pass
    expect(await runner.runOnce()).toMatchObject({ status: 'ok', report: { verified: 6 } });
    expect(runner.status().consecutive_failures).toBe(0);
  });

  test('provider unavailable: stable error codes only, exponential backoff, recovery resets, schedule never overlaps', async () => {
    const { rx, p } = fresh(); await order(rx, 1);
    const clock = new FakeClock(); let mode: 'down' | 'up' = 'down'; let calls = 0;
    const flaky: LightningProvider = { ...p, bindingsPage: async (after, limit) => { calls++; if (mode === 'down') throw new Error('https://secret-host.example/token=abc failed'); return rx.bindings(after, limit); } };
    const runner = createFeedRunner({ enabled: true, provider: flaky, db: db as any, clock, intervalMs: 60_000 });
    runner.start(); expect(clock.pending()).toEqual([60_000]);
    await clock.advance(60_000); expect(calls).toBe(1); expect(runner.status()).toMatchObject({ consecutive_failures: 1, last_outcome: 'error' });
    expect(JSON.stringify(runner.status())).not.toContain('secret-host');
    expect(clock.pending()).toEqual([120_000]);
    await clock.advance(120_000); expect(calls).toBe(2); expect(clock.pending()).toEqual([240_000]);
    mode = 'up'; await clock.advance(240_000);
    expect(runner.status()).toMatchObject({ consecutive_failures: 0, last_outcome: 'ok' }); expect(clock.pending()).toEqual([60_000]);
    runner.stop(); expect(clock.pending()).toEqual([]);
    expect(await runner.runOnce()).toMatchObject({ status: 'ok' }); // manual passes still work after stop
  });

  test('a provider error with a stable code is kept as that code; the fingerprint mismatch of a hostile feed fails closed and credits nothing', async () => {
    const { rx, p } = fresh(); await order(rx, 1);
    const before = await money();
    const hostile: LightningProvider = { ...p, bindingsPage: async (a, l) => ({ ...(await rx.bindings(a, l)), treasuryFingerprint: 'someone-else' }) };
    const runner = createFeedRunner({ enabled: true, provider: hostile, db: db as any, clock: new FakeClock() });
    expect(await runner.runOnce()).toEqual({ status: 'error', code: 'receiver_feed_invalid' });
    expect(await money()).toBe(before); expect(await watermark(rx.fingerprint)).toBe(0);
  });

  test('gap and digest conflict are surfaced as attention, the watermark never passes a hole, and a throwing alert hook changes nothing', async () => {
    const { rx, p } = fresh(); await order(rx, 4);
    rx.order.splice(2, 1); // receiver chain hole
    const runner = createFeedRunner({ enabled: true, provider: p, db: db as any, clock: new FakeClock(), onReport: () => { throw new Error('hook'); } });
    const out = await runner.runOnce();
    expect(out).toMatchObject({ status: 'ok', report: { gap: true, verified: 2 } });
    expect((out as any).attention).toContain('gap');
    expect(await watermark(rx.fingerprint)).toBe(2);
    expect(runner.status().last_outcome).toBe('ok');
  });

  test('interval, batch, page and timeout inputs are clamped to hard bounds', async () => {
    const { rx, p } = fresh(); await order(rx, 1);
    const limits: number[] = [];
    const spy: LightningProvider = { ...p, bindingsPage: (a, l) => { limits.push(l); return rx.bindings(a, l); } };
    const clock = new FakeClock();
    const runner = createFeedRunner({ enabled: true, provider: spy, db: db as any, clock, intervalMs: 1, batch: 1_000_000, maxPages: 999, timeoutMs: 1 });
    runner.start(); expect(clock.pending()).toEqual([FEED_RUNNER_LIMITS.minIntervalMs]); runner.stop();
    await runner.runOnce(); expect(limits[0]).toBe(FEED_RUNNER_LIMITS.maxBatch);
    const huge = createFeedRunner({ enabled: true, provider: spy, db: db as any, clock, intervalMs: Number.NaN });
    huge.start(); expect(clock.pending()).toEqual([300_000]); huge.stop();
  });
});
