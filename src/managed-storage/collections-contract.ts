import {
  digest,
  exactObject,
  httpsOrigin,
  requireCondition,
  sha256,
  uuid,
} from "./contract";
export interface CollectionRef {
  name: string;
  part: number;
  object_id: string;
  sha256: string;
  bytes: number;
}
export interface CollectionMetadata {
  set_id: string;
  source: {
    origin: string;
    identity: string;
    scope: "provider" | "workspace";
    workspaceId: string | null;
  };
  created: string;
  anchor: { object_id: string; sha256: string };
  total_count: number;
}
export function collectionMetadata(value: unknown): CollectionMetadata {
  const m = exactObject(value, [
    "set_id",
    "source",
    "created",
    "anchor",
    "total_count",
  ]);
  const s = exactObject(m.source, [
    "origin",
    "identity",
    "scope",
    "workspaceId",
  ]);
  httpsOrigin(s.origin);
  const a = exactObject(m.anchor, ["object_id", "sha256"]);
  requireCondition(
    uuid.test(String(m.set_id)) &&
      uuid.test(String(a.object_id)) &&
      sha256.test(String(a.sha256)) &&
      typeof s.identity === "string" &&
      s.identity.length > 0 &&
      s.identity.length <= 256 &&
      (s.scope === "provider"
        ? s.workspaceId === null
        : s.scope === "workspace" && uuid.test(String(s.workspaceId))) &&
      typeof m.created === "string" &&
      new Date(m.created).toISOString() === m.created &&
      Number.isInteger(m.total_count) &&
      Number(m.total_count) > 0 &&
      Number(m.total_count) <= 100000,
    "storage_collection_invalid",
  );
  return {
    set_id: m.set_id as string,
    source: {
      origin: s.origin as string,
      identity: s.identity,
      scope: s.scope as "provider" | "workspace",
      workspaceId: s.workspaceId as string | null,
    },
    created: m.created,
    anchor: { object_id: a.object_id as string, sha256: a.sha256 as string },
    total_count: Number(m.total_count),
  };
}
export function collectionRefs(value: unknown): CollectionRef[] {
  requireCondition(
    Array.isArray(value) && value.length > 0 && value.length <= 50,
    "storage_collection_invalid",
  );
  return value.map((v) => {
    const r = exactObject(v, ["name", "part", "object_id", "sha256", "bytes"]);
    requireCondition(
      typeof r.name === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(r.name) &&
        !r.name.includes("..") &&
        Number.isSafeInteger(r.part) &&
        Number(r.part) >= 0 &&
        uuid.test(String(r.object_id)) &&
        sha256.test(String(r.sha256)) &&
        Number.isSafeInteger(r.bytes) &&
        Number(r.bytes) > 0 &&
        Number(r.bytes) <= 8388608,
      "storage_collection_invalid",
    );
    return {
      name: r.name,
      part: Number(r.part),
      object_id: String(r.object_id),
      sha256: String(r.sha256),
      bytes: Number(r.bytes),
    };
  });
}
export function sortedRefs(refs: CollectionRef[]) {
  return [...refs].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.part - b.part,
  );
}
export function membershipDigest(m: CollectionMetadata, refs: CollectionRef[]) {
  return digest(
    JSON.stringify({
      set_id: m.set_id,
      scope: m.source.scope,
      workspaceId: m.source.workspaceId,
      anchor: { object_id: m.anchor.object_id, sha256: m.anchor.sha256 },
      total_count: m.total_count,
      refs: sortedRefs(refs).map((r) => ({
        name: r.name,
        part: r.part,
        object_id: r.object_id,
        sha256: r.sha256,
        bytes: r.bytes,
      })),
    }),
  );
}
export function graphKey(workspace: string, delegation: string) {
  return `managed-storage:${workspace}:${delegation}`;
}
