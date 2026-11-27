import { ensureServiceIdentity } from './service-identity';
import { startFipsIngress } from './fips-ingress';

const identity = await ensureServiceIdentity();

const [{ createApp }, { config }, { getDb }, { ensureRuntimeSchema }, { startHostingBillingRunner }, { startNotificationWorker }, { checkStorageMigrationStartupGuard, verifyAuthenticatedStorageReadiness }] = await Promise.all([
  import('./server'),
  import('./config'),
  import('./db'),
  import('./schema/ensure-runtime-schema'),
  import('./services/hosting-billing'),
  import('./services/notification-worker'),
  import('./services/storage-startup-guard'),
]);

// Delivery classification uses the database provider (fail closed); traffic is served only after the schema below.
const { databaseCeilingProvider } = await import('./services/agent-notifications');
const app = createApp({ agentCeiling: databaseCeilingProvider() });

// Verify DB connection, storage migration startup guard, and authenticated storage readiness before serving.
try {
  const sql = getDb();
  await sql`SELECT 1`;
  // Read-only guard first: no DDL may run while a migration holds the store quiesced.
  const guard = await checkStorageMigrationStartupGuard(sql, {
    provider: config.storage.provider,
    startRunId: process.env.NSTACK_MIGRATION_START_RUN_ID || null,
  });
  await ensureRuntimeSchema();
  await verifyAuthenticatedStorageReadiness({
    provider: config.storage.provider,
    endpoint: config.storage.s3Endpoint,
    region: config.storage.s3Region,
    bucket: config.storage.s3Bucket,
    accessKey: config.storage.s3AccessKey,
    secretKey: config.storage.s3SecretKey,
    forcePathStyle: config.storage.s3ForcePathStyle,
    expectedSentinelId: guard.expectedSentinelId,
    requireSentinel: config.storage.requireSentinel,
    maxAttempts: config.storage.readyMaxAttempts,
    retryDelayMs: config.storage.readyRetryDelayMs,
  });
  console.log(`[nstack] DB connected: ${config.db.host}:${config.db.port}/${config.db.database}`);
  console.log(`[nstack] Storage ready: provider=${config.storage.provider} bucket=${config.storage.s3Bucket}`);
} catch (err) {
  console.error('[nstack] Startup check failed:', err);
  process.exit(1);
}

startHostingBillingRunner();
const { startWorkspaceBillingRunner } = await import('./services/hosting-workspace-billing');
startWorkspaceBillingRunner();
// Peak-storage meter for the approved onboarding policy; a no-op until a workspace is enrolled and activated.
const { startStoragePeakRunner, registerStorageProtectionReserve } = await import('./services/hosting-storage');
registerStorageProtectionReserve();
// Agent holds reserve: a real query over open holds (zero when none), so refunds and admission account for admitted agent work.
const { registerAgentHoldsReserve } = await import('./services/hosting-agent-holds');
registerAgentHoldsReserve();
startStoragePeakRunner();
// Durable 30/7/1-day runway and read-only notices (deduplicated per funding cycle; no deletion capability).
const { startLifecycleNoticeRunner } = await import('./services/hosting-lifecycle');
startLifecycleNoticeRunner();
// Durable notification projection runs in this process (NOTIF_PROJECTOR=off disables it).
startNotificationWorker();
// Strict agent notification inbox projection (AGENT_NOTIF_PROJECTOR=off disables only this path).
const { startAgentNotificationWorker } = await import('./services/agent-notification-projector');
startAgentNotificationWorker();
// Durable push alert delivery (NOTIF_ALERTS=off disables); idle unless APNs is fully configured.
const { startAlertWorker } = await import('./services/notification-alerts');
startAlertWorker();
// Agent activity lease expiry events (AGENT_ACTIVITY_LEASE_SWEEP_MS=0 disables).
const { startAgentActivityLeaseSweeper } = await import('./services/agent-activity-lease-sweeper');
startAgentActivityLeaseSweeper();

console.log(`[nstack] listening on :${config.port}`);
console.log(`[nstack] service npub: ${identity.npub}`);

// Optional dedicated ingress (native mesh or Docker seam); shares app/DB/SSE hub.
startFipsIngress(app.fetch);

export default {
  port: config.port,
  fetch: app.fetch,
};
