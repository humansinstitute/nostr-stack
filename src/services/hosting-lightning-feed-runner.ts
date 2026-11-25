import { getDb } from '../db';
import { reconcileBindingFeed, type FeedReport } from './hosting-lightning-receiver';
import type { LightningProvider } from './hosting-lightning';

/** Periodic receiver binding COMPLETENESS runner. Trusted startup only: the operator's startup code passes the already-trusted provider object and
 * `enabled: true`; nothing here reads an environment value, request or response to choose a provider, and nothing starts it by default.
 * It runs the same `reconcileBindingFeed` the administrator route runs (continuity, orphans, conflicts) and nothing else: it never settles a quote,
 * credits, refunds, sweeps, messages a user or interprets a PAID string. A report is an alert signal for operators, never evidence of payment. */
type Db = ReturnType<typeof getDb>;

export const FEED_RUNNER_LIMITS = { minIntervalMs: 30_000, maxIntervalMs: 3_600_000, maxBatch: 200, maxPages: 20, minTimeoutMs: 1_000, maxTimeoutMs: 120_000 } as const;
const LOCK_KEY = 'hosting-lightning-binding-feed-runner';

export interface FeedRunnerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realClock: FeedRunnerClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>) };

export interface FeedRunnerOptions {
  /** Must be explicitly true. The default is a disabled, inert runner. */
  enabled: boolean;
  /** The trusted, already-configured provider. Must be mint-backed with a bindings feed. */
  provider: LightningProvider | null;
  intervalMs?: number; batch?: number; maxPages?: number; timeoutMs?: number;
  db?: Db; clock?: FeedRunnerClock;
  /** Operator alert hook. Receives the report only; failures in it are swallowed and never change feed state. */
  onReport?: (report: FeedReport, attention: FeedAttention[]) => void;
}
export type FeedAttention = 'gap' | 'conflicts' | 'orphans' | 'behind' | 'quotes_without_binding';
export type FeedRunOutcome =
  | { status: 'disabled' | 'unconfigured' | 'stalled' | 'overlap' | 'locked' }
  | { status: 'timeout' | 'error'; code: string }
  | { status: 'ok'; report: FeedReport; attention: FeedAttention[] };

export function feedAttention(r: FeedReport): FeedAttention[] {
  const out: FeedAttention[] = [];
  if (r.gap) out.push('gap'); if (r.conflicts) out.push('conflicts'); if (r.orphans) out.push('orphans'); if (r.behind) out.push('behind');
  if (r.quotes_without_binding.length) out.push('quotes_without_binding');
  return out;
}
const clamp = (v: number | undefined, def: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? Math.floor(v as number) : def));
class Aborted extends Error { constructor() { super('feed_run_aborted'); } }

export interface FeedRunner {
  /** One bounded pass now. Never overlaps itself or another process's pass. */
  runOnce(): Promise<FeedRunOutcome>;
  start(): void; stop(): void;
  status(): { running: boolean; in_flight: boolean; consecutive_failures: number; last_outcome: string | null; last_run_at: number | null; last_report: FeedReport | null; last_attention: FeedAttention[] };
}

export function createFeedRunner(o: FeedRunnerOptions): FeedRunner {
  const clock = o.clock ?? realClock;
  const p = o.provider;
  const supported = !!p && (p.evidenceKind ?? 'preimage') === 'mint_redemption' && typeof p.bindingsPage === 'function' && !!p.mintBacked;
  const intervalMs = clamp(o.intervalMs, 300_000, FEED_RUNNER_LIMITS.minIntervalMs, FEED_RUNNER_LIMITS.maxIntervalMs);
  const batch = clamp(o.batch, 100, 1, FEED_RUNNER_LIMITS.maxBatch);
  const maxPages = clamp(o.maxPages, 5, 1, FEED_RUNNER_LIMITS.maxPages);
  const timeoutMs = clamp(o.timeoutMs, 30_000, FEED_RUNNER_LIMITS.minTimeoutMs, FEED_RUNNER_LIMITS.maxTimeoutMs);
  let started = false, inFlight = false, timer: unknown = null, failures = 0;
  let lastOutcome: string | null = null, lastRunAt: number | null = null, lastReport: FeedReport | null = null, lastAttention: FeedAttention[] = [];

  async function pass(db: Db, signal: { aborted: boolean }): Promise<FeedReport> {
    const feed = p!;
    const fetchPage = async (after: number, limit: number) => { if (signal.aborted) throw new Aborted(); const page = await feed.bindingsPage!(after, limit); if (signal.aborted) throw new Aborted(); return page; };
    return reconcileBindingFeed(db, fetchPage, feed.mintBacked!, batch, maxPages);
  }

  async function runOnce(): Promise<FeedRunOutcome> {
    if (!o.enabled) return { status: 'disabled' };
    if (!supported) return { status: 'unconfigured' };
    // In-flight is held until the underlying work has actually settled, not merely until the timeout fired: a wedged call can never be doubled up.
    if (inFlight) return { status: 'overlap' };
    inFlight = true;
    const signal = { aborted: false };
    const db = o.db ?? getDb();
    let reserved: Awaited<ReturnType<Db['reserve']>> | null = null, locked = false;
    let timeout: unknown = null;
    const work = (async (): Promise<FeedRunOutcome> => {
      reserved = await db.reserve();
      // Session advisory lock on a dedicated connection: another process or a restarted instance cannot run a pass concurrently, and a dropped connection releases it.
      const [got] = await reserved`SELECT pg_try_advisory_lock(hashtextextended(${LOCK_KEY}, 0)) AS ok`;
      if (!got?.ok) return { status: 'locked' };
      locked = true;
      const report = await pass(db, signal);
      return { status: 'ok', report, attention: feedAttention(report) };
    })();
    const settled = work.then(r => r, e => ({ status: 'error', code: e instanceof Aborted ? 'aborted' : codeOf(e) }) as FeedRunOutcome)
      .finally(async () => {
        try { if (reserved) { if (locked) await (reserved as any)`SELECT pg_advisory_unlock(hashtextextended(${LOCK_KEY}, 0))`; (reserved as any).release(); } } catch { /* a broken connection drops the session lock itself */ }
        inFlight = false;
      });
    const deadline = new Promise<FeedRunOutcome>(resolve => { timeout = clock.setTimeout(() => { signal.aborted = true; resolve({ status: 'timeout', code: 'timeout' }); }, timeoutMs); });
    const outcome = await Promise.race([settled, deadline]);
    clock.clearTimeout(timeout);
    lastRunAt = clock.now(); lastOutcome = outcome.status;
    if (outcome.status === 'ok') {
      failures = 0; lastReport = outcome.report; lastAttention = outcome.attention;
      if (o.onReport) { try { o.onReport(outcome.report, outcome.attention); } catch { /* operator hook only */ } }
    } else if (outcome.status === 'timeout' || outcome.status === 'error') failures++;
    return outcome;
  }

  const nextDelay = () => Math.min(intervalMs * 2 ** Math.min(failures, 3), FEED_RUNNER_LIMITS.maxIntervalMs);
  function schedule() {
    if (!started) return;
    timer = clock.setTimeout(async () => { timer = null; try { await runOnce(); } catch { failures++; } schedule(); }, nextDelay());
  }
  return {
    runOnce,
    start() { if (started || !o.enabled || !supported) return; started = true; schedule(); },
    stop() { started = false; if (timer !== null) clock.clearTimeout(timer); timer = null; },
    status: () => ({ running: started, in_flight: inFlight, consecutive_failures: failures, last_outcome: lastOutcome, last_run_at: lastRunAt, last_report: lastReport, last_attention: lastAttention }),
  };
}
/** Short stable code only: provider or database error text can carry request detail and is never retained. */
const codeOf = (e: unknown) => { const m = e instanceof Error ? e.message : ''; return /^[a-z][a-z0-9_]{2,60}$/.test(m) ? m : 'feed_error'; };
