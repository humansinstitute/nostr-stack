import { getDb } from '../db';
import { HostingError } from './hosting-billing';
import { accountStorageSummary } from './hosting-storage';

type Db = ReturnType<typeof getDb>;
const DAY = 86_400_000;
/** Free read-only migration period after funds are exhausted (approved policy). */
export const READ_ONLY_DAYS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type NoticeKind = 'runway_30d' | 'runway_7d' | 'runway_1d' | 'read_only_entered' | 'removal_due';
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

/** Read-only recovery state of one owner account. Pure projection of the ledger/account facts: it performs no operation, never
 * deletes anything and makes no promise the platform cannot keep (there is no verified offline recovery copy to restore from). */
export async function accountLifecycle(db: Db, accountId: string, now = new Date()) {
  const [account] = await db`SELECT * FROM hosting_accounts WHERE id=${accountId}`;
  if (!account) throw new HostingError(404, 'billing_account_not_found');
  const summary = await accountStorageSummary(db, accountId, now);
  const spendable = BigInt(summary.balances.spendable_units);
  const readOnly = Boolean(account.depleted_at) && spendable <= 0n;
  const entered = readOnly ? new Date(account.depleted_at) : null;
  const ends = entered ? new Date(entered.getTime() + READ_ONLY_DAYS * DAY) : null;
  const removalDue = ends !== null && now.getTime() >= ends.getTime();
  const state = summary.runway.state === 'no_billed_workspace' ? 'no_billed_workspace'
    : readOnly ? (removalDue ? 'removal_due' : 'read_only')
    : summary.runway.warning_days !== null ? 'warning' : summary.runway.state === 'measurement_unavailable' ? 'unknown' : 'active';
  let uncollected = 0n;
  if (entered) {
    const [row] = await db`SELECT COALESCE(sum(uncollected_units),0)::text AS units FROM hosting_storage_hours WHERE account_id=${accountId} AND hour>=date_trunc('hour',${entered}::timestamptz)`;
    uncollected = BigInt(row!.units);
  }
  return {
    version: 1 as const, account_id: accountId, as_of: now.toISOString(), state: state as 'active' | 'warning' | 'read_only' | 'removal_due' | 'no_billed_workspace' | 'unknown',
    runway: { state: summary.runway.state, hours: summary.runway.hours, funded_until: summary.runway.funded_until, warning_days: summary.runway.warning_days, upper_bound: summary.runway.upper_bound },
    read_only: entered ? {
      entered_at: entered.toISOString(), ends_at: ends!.toISOString(), days_remaining: Math.max(0, Math.ceil((ends!.getTime() - now.getTime()) / DAY)),
      writes_blocked: true, export_available: true, export_path: '/api/v4/hosting-billing/workspaces/{workspaceId}/migration-export',
      billing: { new_debt: false, exit_fee: false, back_charge_on_top_up: false, uncollected_units_not_charged: uncollected.toString() },
      resume: { by: 'top_up', charging: 'prospective_only' },
    } : null,
    removal: {
      due_at: ends ? ends.toISOString() : null, due: removalDue, automatic_deletion: false, live_removal_performed: false,
      note: removalDue ? 'The free read-only period has ended. Nothing is deleted automatically; any removal is a separate, explicit operator action.' : null,
    },
    offline_recovery: {
      available: false, verified: false, promised: false,
      reason: 'No isolated, encrypted, expiring offline recovery copy or support restore exists or has been verified. Live removal must not be described as erasure or as recoverable.',
    },
    agents: { resume_requires_explicit_confirmation: true, implemented: false },
    export_complete: false, // see docs/contract/workspace-migration-export-v1.md: every manifest is incomplete while content families are unexported
  };
}

async function fundingCycle(db: Db, accountId: string) {
  const [credit] = await db`SELECT id FROM hosting_ledger WHERE account_id=${accountId} AND amount_units>0 AND kind IN ('stripe','lightning','admin') ORDER BY created_at DESC,id DESC LIMIT 1`;
  return credit ? String(credit.id) : 'initial';
}

/** Records the notices an account has earned, once each per cycle. Idempotent and safe under concurrent runners.
 * Runway warnings mark only the most urgent threshold crossed (a drop straight to one day does not also emit 30 and 7). */
export async function evaluateLifecycleNotices(db: Db, accountId: string, now = new Date()) {
  const view = await accountLifecycle(db, accountId, now);
  const wanted: { kind: NoticeKind; cycle: string; payload: Record<string, unknown> }[] = [];
  if (view.read_only) {
    const cycle = view.read_only.entered_at;
    wanted.push({ kind: 'read_only_entered', cycle, payload: { ends_at: view.read_only.ends_at, export_available: true, resume: 'top_up', writes_blocked: true } });
    if (view.removal.due) wanted.push({ kind: 'removal_due', cycle, payload: { due_at: view.removal.due_at, automatic_deletion: false, live_removal_performed: false } });
  } else if (view.runway.warning_days !== null) {
    wanted.push({ kind: `runway_${view.runway.warning_days}d` as NoticeKind, cycle: await fundingCycle(db, accountId), payload: { warning_days: view.runway.warning_days, runway_hours: view.runway.hours, funded_until: view.runway.funded_until, upper_bound: view.runway.upper_bound } });
  }
  const created: string[] = [];
  for (const w of wanted) {
    const [row] = await db`INSERT INTO hosting_lifecycle_notices(account_id,kind,cycle_key,payload) VALUES(${accountId},${w.kind},${w.cycle},${db.json(w.payload as any)}) ON CONFLICT(account_id,kind,cycle_key) DO NOTHING RETURNING id`;
    if (row) created.push(w.kind);
  }
  return { created, state: view.state };
}

export async function listLifecycleNotices(db: Db, accountId: string, limit = 50) {
  const bound = Number.isSafeInteger(limit) ? Math.max(1, Math.min(200, limit)) : 50;
  const rows = await db`SELECT id,kind,cycle_key,payload,created_at,acknowledged_at FROM hosting_lifecycle_notices WHERE account_id=${accountId} ORDER BY (acknowledged_at IS NULL) DESC,created_at DESC,id LIMIT ${bound}`;
  return rows.map(r => ({ id: r.id as string, kind: r.kind as NoticeKind, payload: r.payload as Record<string, unknown>, created_at: iso(r.created_at)!, acknowledged_at: iso(r.acknowledged_at) }));
}
export async function acknowledgeLifecycleNotice(db: Db, accountId: string, noticeId: string) {
  if (!UUID.test(noticeId)) throw new HostingError(404, 'notice_not_found');
  const [row] = await db`UPDATE hosting_lifecycle_notices SET acknowledged_at=COALESCE(acknowledged_at,now()) WHERE id=${noticeId} AND account_id=${accountId} RETURNING id,kind,acknowledged_at`;
  if (!row) throw new HostingError(404, 'notice_not_found');
  return { id: row.id as string, kind: row.kind as NoticeKind, acknowledged_at: iso(row.acknowledged_at)! };
}
/** Evaluates every account that has an activated billed workspace; called by the storage runner after settlement. */
export async function evaluateAllLifecycleNotices(db: Db = getDb(), now = new Date()) {
  const accounts = await db`SELECT DISTINCT account_id FROM hosting_storage_enrollments WHERE activated_at IS NOT NULL ORDER BY account_id LIMIT 256`;
  let evaluated = 0;
  for (const a of accounts) { try { await evaluateLifecycleNotices(db, a.account_id, now); evaluated++; } catch { /* the next tick retries; one account never blocks the rest */ } }
  return { evaluated };
}

/** Idempotent, so overlapping instances only race on ON CONFLICT DO NOTHING. A no-op until a workspace is enrolled and activated. */
export function startLifecycleNoticeRunner(intervalMs = 300_000) {
  let running = false;
  const tick = async () => { if (running) return; running = true; try { await evaluateAllLifecycleNotices(); } catch { console.error('[lifecycle] notice evaluation failed; retry next interval'); } finally { running = false; } };
  const timer = setInterval(() => void tick(), intervalMs); timer.unref();
  return () => clearInterval(timer);
}
