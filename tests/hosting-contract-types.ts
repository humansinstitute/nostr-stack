import type { HostingAccountLedgerEntry, HostingWorkspaceLedgerEntry, HostingLedgerEntry, HostingWorkspaceBillingStatus, HostingAccountBillingStatus, HostingBillingStatus, HostingUsageHour, HostingWorkspaceUsageMeasurement } from '../src/types';
type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Kinds = Assert<Equal<HostingLedgerEntry['kind'], 'welcome' | 'usage' | 'admin' | 'stripe' | 'promo_expiry' | 'workspace_allocation' | 'workspace_usage'>>;
type Scope = Assert<Equal<HostingAccountLedgerEntry['balance_scope'], 'account' | 'workspace'>>;
type ManagerKeys = Assert<Equal<keyof HostingWorkspaceLedgerEntry, 'id' | 'workspace_id' | 'kind' | 'amount_units' | 'created_at'>>;
type ManagerKinds = Assert<Equal<HostingWorkspaceLedgerEntry['kind'], 'usage' | 'workspace_usage'>>;
type MeasurementKeys = Assert<Equal<keyof HostingWorkspaceUsageMeasurement, 'workspace_id' | 'hour' | 'status' | 'bytes' | 'debit_units'>>;
type ManagerMeasurements = Assert<Equal<HostingWorkspaceBillingStatus['measurements'][number], HostingWorkspaceUsageMeasurement>>;
type OwnerMeasurements = Assert<Equal<HostingAccountBillingStatus['measurements'][number], Omit<HostingUsageHour, 'account_id' | 'collected_at'>>>;
type StatusModes = Assert<Equal<HostingBillingStatus['billing_mode'], 'usd_prepaid' | 'legacy_unlinked'>>;
function narrow(entry: HostingLedgerEntry, status: HostingBillingStatus) {
  // @ts-expect-error The public union never guarantees private account data.
  entry.account_id;
  if ('balance_scope' in entry) entry.paid_after_units satisfies string;
  if ('financial_scope' in status) {
    status.measurements satisfies HostingWorkspaceUsageMeasurement[];
    // @ts-expect-error Workspace authority has no account balance.
    status.balance_units;
    // @ts-expect-error Manager measurements have no nested evidence.
    status.measurements[0]!.evidence;
  }
}
