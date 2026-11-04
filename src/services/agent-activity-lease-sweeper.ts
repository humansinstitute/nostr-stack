import { getDb } from '../db';
import { sweepExpiredFlightDeckPgAgentActivityLeases } from './flightdeck-pg-api';

// Expiry convergence for clients that are not running their own clock
// (offline, suspended, replaying). Renewal correctness never depends on it.
// AGENT_ACTIVITY_LEASE_SWEEP_MS=0 disables; default every 15 s.
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

export function startAgentActivityLeaseSweeper(sql = getDb()) {
  if (timer) return stopAgentActivityLeaseSweeper;
  const configured = Bun.env.AGENT_ACTIVITY_LEASE_SWEEP_MS;
  const intervalMs = configured === undefined || configured === '' ? 15_000 : Number(configured);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    console.log('[agent-activity] lease sweeper disabled by AGENT_ACTIVITY_LEASE_SWEEP_MS');
    return stopAgentActivityLeaseSweeper;
  }
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      // Bounded batches; stop early once a pass finds nothing due.
      for (let i = 0; i < 5; i += 1) {
        const { expired } = await sweepExpiredFlightDeckPgAgentActivityLeases({}, sql);
        if (expired < 500) break;
      }
    } catch (error) {
      console.error('[agent-activity] lease sweep failed:', (error instanceof Error ? error.message : String(error)).slice(0, 300));
    } finally {
      busy = false;
    }
  };
  timer = setInterval(tick, Math.max(1_000, intervalMs));
  timer.unref?.();
  void tick();
  console.log('[agent-activity] lease sweeper started');
  return stopAgentActivityLeaseSweeper;
}

export function stopAgentActivityLeaseSweeper() {
  if (timer) clearInterval(timer);
  timer = null;
}
