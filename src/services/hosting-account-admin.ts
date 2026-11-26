import { getDb } from '../db';
import { getTowerBuildInfo } from '../build-info';
import { HostingError, stripeAvailability, unitsUsd } from './hosting-billing';
import { lightningAvailable } from './hosting-lightning';
import { onboardingEnabled } from './onboarding';
import { approvedCheckoutReturnUrls } from './hosting-stripe';

type Db = ReturnType<typeof getDb>;
export const ADMIN_ACCOUNT_DEFAULT_LIMIT = 25;
export const ADMIN_ACCOUNT_MAX_LIMIT = 100;
export const ADMIN_ACCOUNT_MAX_OFFSET = 100_000;
const WORKSPACE_NAME_SAMPLE = 5;
const LABEL_MAX = 80;

/** Operator configuration only: what this deployment can do right now. No secrets, return URLs or provider configuration. */
export function providerAvailability() {
  const stripe = stripeAvailability();
  const card = onboardingEnabled() && stripe.configured && stripe.mode === 'test' && approvedCheckoutReturnUrls().length > 0;
  return {
    onboarding_enabled: onboardingEnabled(),
    card: { available: card, mode: stripe.mode, live_rollout_blocked: stripe.live_rollout_blocked },
    lightning: { available: onboardingEnabled() && lightningAvailable() },
  };
}

function pageParam(raw: string | undefined, fallback: number, min: number, max: number, code: string) {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,9}$/.test(raw)) throw new HostingError(400, code);
  const value = Number(raw);
  if (value < min || value > max) throw new HostingError(400, code);
  return value;
}
export function parseAccountPage(query: { limit?: string; offset?: string }) {
  return {
    limit: pageParam(query.limit, ADMIN_ACCOUNT_DEFAULT_LIMIT, 1, ADMIN_ACCOUNT_MAX_LIMIT, 'invalid_limit'),
    offset: pageParam(query.offset, 0, 0, ADMIN_ACCOUNT_MAX_OFFSET, 'invalid_offset'),
  };
}

/**
 * Explicit, read-only administrator projection of the shared USD hosting accounts (never the legacy workspace credit ledger).
 * Selects only named columns; it never reads invoices, checkout sessions, ledger reasons or actors, provider configuration,
 * identity backups or replay keys, and performs no writes (promo expiry is computed here, not recorded).
 */
export async function listHostingAccountsForAdmin(page: { limit: number; offset: number }, db: Db = getDb(), now = new Date()) {
  const [{ total }] = await db`SELECT count(*)::int AS total FROM hosting_accounts` as { total: number }[];
  const rows = await db`
    SELECT a.id, a.paid_units, a.promo_units, a.promo_expires_at, a.opened_by, a.created_at,
      o.npub AS owner_npub, o.display_name AS owner_label,
      (SELECT count(*)::int FROM hosting_workspace_accounts l WHERE l.account_id = a.id) AS workspace_count,
      (SELECT COALESCE(jsonb_agg(n.name ORDER BY n.name, n.id), '[]'::jsonb) FROM (
         SELECT w.id, w.name FROM hosting_workspace_accounts l JOIN flightdeck_pg_workspaces w ON w.id = l.workspace_id
         WHERE l.account_id = a.id ORDER BY w.name, w.id LIMIT ${WORKSPACE_NAME_SAMPLE}) n) AS workspace_names,
      i.status AS intent_status, i.funding_cents AS intent_funding_cents, i.created_at AS intent_created_at,
      i.updated_at AS intent_updated_at, i.provisioned_at AS intent_provisioned_at, i.last_error AS intent_last_error
    FROM hosting_accounts a
    JOIN flightdeck_pg_actors o ON o.id = a.owner_actor_id
    LEFT JOIN LATERAL (
      SELECT status, funding_cents, created_at, updated_at, provisioned_at, last_error FROM onboarding_intents
      WHERE account_id = a.id ORDER BY updated_at DESC, id DESC LIMIT 1) i ON true
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${page.limit} OFFSET ${page.offset}`;
  const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());
  const accounts = rows.map(r => {
    const paid = BigInt(r.paid_units);
    const promoActive = new Date(r.promo_expires_at).getTime() > now.getTime() ? BigInt(r.promo_units) : 0n;
    const purchased = paid > 0n ? paid : 0n;
    const debt = paid < 0n ? -paid : 0n;
    const label = typeof r.owner_label === 'string' && r.owner_label.trim() ? r.owner_label.trim().slice(0, LABEL_MAX) : null;
    return {
      account_id: r.id as string,
      owner_npub: r.owner_npub as string,
      owner_label: label,
      opened_by: r.opened_by as string,
      created_at: iso(r.created_at)!,
      purchased_units: purchased.toString(), purchased_usd: unitsUsd(purchased),
      promo_units: promoActive.toString(), promo_usd: unitsUsd(promoActive), promo_expires_at: iso(r.promo_expires_at)!,
      reversal_debt_units: debt.toString(), reversal_debt_usd: unitsUsd(debt),
      balance_units: (paid + promoActive).toString(), balance_usd: unitsUsd(paid + promoActive),
      workspaces: { count: r.workspace_count as number, names: r.workspace_names as string[] },
      latest_onboarding: r.intent_status === null ? null : {
        status: r.intent_status as string, funding_cents: r.intent_funding_cents as number,
        created_at: iso(r.intent_created_at)!, updated_at: iso(r.intent_updated_at)!, provisioned_at: iso(r.intent_provisioned_at),
        last_error: (r.intent_last_error as string | null) ?? null,
      },
    };
  });
  const build = getTowerBuildInfo();
  return {
    version: 1,
    refreshed_at: now.toISOString(),
    build: { git_commit: build.git_commit, git_branch: build.git_branch, build_time: build.build_time, version: build.version },
    providers: providerAvailability(),
    total,
    limit: page.limit,
    offset: page.offset,
    has_more: page.offset + accounts.length < total,
    accounts,
  };
}
