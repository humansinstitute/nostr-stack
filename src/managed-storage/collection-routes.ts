import { exactObject, requireCondition, sha256, uuid } from "./contract";
import type { ManagedStorageService } from "./service";
import type { StorageGrant } from "./grants";
import type { PublisherReceipt } from "./recovery";
export const collectionActions = [
  "collection-begin",
  "collection-page",
  "collection-seal",
  "collection-abort",
  "collection-status",
  "collection-list",
  "deletion-preview",
  "deletion-page",
  "deletion-arm",
  "deletion-cancel",
  "deletion-confirm",
  "deletion-status",
  "deletion-resume",
];
export const collectionFields: Record<string, string[]> = {
  "collection-begin": ["metadata", "membership_digest"],
  "collection-page": ["set_id", "page", "refs"],
  "collection-seal": ["set_id"],
  "collection-abort": ["set_id"],
  "collection-status": ["set_id", "page"],
  "collection-list": ["page"],
  "deletion-preview": ["set_id"],
  "deletion-page": ["preview_id", "page"],
  "deletion-arm": ["preview_id", "digest"],
  "deletion-cancel": ["preview_id"],
  "deletion-confirm": [
    "preview_id",
    "digest",
    "confirmation_token",
    "set_id",
    "anchor_sha256",
    "membership_digest",
    "total_count",
    "graph_revision",
    "snapshot_expires_at",
    "confirmation_expires_at",
  ],
  "deletion-status": ["preview_id"],
  "deletion-resume": ["preview_id"],
};
export function collectionBody(
  action: string,
  value: unknown,
  common: string[],
) {
  return exactObject(value, [...common, ...collectionFields[action]!]);
}
export async function collectionControl(
  s: ManagedStorageService,
  g: StorageGrant,
  action: string,
  b: any,
  receipt: PublisherReceipt,
  signal: AbortSignal,
) {
  const c = s.collections;
  if ("set_id" in b)
    requireCondition(
      typeof b.set_id === "string" && uuid.test(b.set_id),
      "storage_collection_invalid",
    );
  if ("preview_id" in b)
    requireCondition(
      typeof b.preview_id === "string" && uuid.test(b.preview_id),
      "storage_preview_invalid",
    );
  if ("page" in b)
    requireCondition(
      Number.isInteger(b.page) && b.page >= 0 && b.page < 5000,
      "storage_collection_invalid",
    );
  if ("digest" in b)
    requireCondition(
      typeof b.digest === "string" && sha256.test(b.digest),
      "storage_preview_invalid",
    );
  let result: any;
  switch (action) {
    case "collection-begin":
      result = await c.begin(g, b);
      break;
    case "collection-page":
      result = await c.pagePut(g, b.set_id, b);
      break;
    case "collection-seal":
      result = await c.seal(g, b.set_id);
      break;
    case "collection-abort":
      result = await c.abort(g, b.set_id);
      break;
    case "collection-status":
      result = await c.status(g, b.set_id, b.page ?? 0);
      break;
    case "collection-list":
      result = await c.list(g, b.page ?? 0);
      break;
    case "deletion-preview":
      result = await c.snapshot(g, b.set_id);
      break;
    case "deletion-page":
      result = await c.previewPage(g, b.preview_id, b.page ?? 0);
      break;
    case "deletion-arm":
      result = await c.arm(g, b.preview_id, b.digest);
      break;
    case "deletion-cancel":
      result = await c.cancel(g, b.preview_id);
      break;
    case "deletion-confirm":
      result = await c.confirm(g, b.preview_id, b, receipt);
      break;
    case "deletion-status":
      result = await c.job(g, b.preview_id);
      break;
    case "deletion-resume":
      result = await c.resume(g, b.preview_id, signal);
      break;
    default:
      throw Error("Invalid managed collection action");
  }
  return { ...s.binding(g), ...result };
}
