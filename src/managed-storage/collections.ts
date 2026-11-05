import { canonical } from "./deletion-canonical";
import { randomBytes, randomUUID } from "node:crypto";
import { digest, requireCondition, sha256, tokenPattern } from "./contract";
import {
  collectionMetadata,
  collectionRefs,
  graphKey,
  membershipDigest,
  sortedRefs,
  type CollectionMetadata,
  type CollectionRef,
} from "./collections-contract";
import type { ManagedStorageService } from "./service";
import type { StorageGrant } from "./grants";
import type { PublisherReceipt } from "./recovery";
import { objectKey } from "./ledger";

type SetRow = {
  metadata: CollectionMetadata;
  membership_digest: string;
  total_count: number;
  state: string;
  metadata_bytes: string;
};
export class StorageCollections {
  constructor(readonly service: ManagedStorageService) {}
  get ledger() {
    return this.service.options.ledger;
  }
  async locked<T>(g: StorageGrant, fn: (tx: any) => Promise<T>) {
    return this.ledger.transaction(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${graphKey(g.workspaceId, g.delegationId)}))`;
      await this.service.recheck(g, false, tx);
      await tx`INSERT INTO managed_storage_graph(workspace_id,delegation_id) VALUES(${g.workspaceId},${g.delegationId}) ON CONFLICT DO NOTHING`;
      const result = await fn(tx);
      await this.service.recheck(g, false, tx);
      return result;
    });
  }
  async bump(g: StorageGrant, tx: any) {
    await tx`UPDATE managed_storage_graph SET revision=revision+1 WHERE workspace_id=${g.workspaceId} AND delegation_id=${g.delegationId}`;
  }
  async budget(g: StorageGrant, amount: number, tx: any) {
    const usage = await this.ledger.usage(g, tx);
    requireCondition(
      usage.bytes + amount <= g.quotaBytes,
      "storage_budget_exhausted",
      409,
    );
  }
  async set(g: StorageGrant, id: string, tx: any): Promise<SetRow> {
    const [s] =
      await tx`SELECT * FROM managed_storage_sets WHERE workspace_id=${g.workspaceId} AND delegation_id=${g.delegationId} AND id=${id}`;
    requireCondition(s, "storage_collection_not_found", 404);
    // Object authority remains exact, including app/installation, even on read-only metadata paths.
    await this.ledger.object(g, s.metadata.anchor.object_id, tx);
    return s;
  }
  async refs(g: StorageGrant, id: string, tx: any): Promise<CollectionRef[]> {
    const pages =
      await tx`SELECT page,refs FROM managed_storage_set_pages WHERE workspace_id=${g.workspaceId} AND delegation_id=${g.delegationId} AND set_id=${id} ORDER BY page`;
    requireCondition(
      pages.every((p: any, i: number) => p.page === i),
      "storage_collection_incomplete",
      409,
    );
    return pages.flatMap((p: any) => p.refs);
  }
  async revision(g: StorageGrant, tx: any) {
    const [r] =
      await tx`SELECT revision::text FROM managed_storage_graph WHERE workspace_id=${g.workspaceId} AND delegation_id=${g.delegationId}`;
    return r?.revision ?? "0";
  }
  async begin(g: StorageGrant, input: any) {
    const m = collectionMetadata(input.metadata);
    requireCondition(
      typeof input.membership_digest === "string" &&
        sha256.test(input.membership_digest),
      "storage_collection_invalid",
    );
    return this.locked(g, async (tx) => {
      const anchor = await this.ledger.object(g, m.anchor.object_id, tx, true);
      requireCondition(
        anchor.state === "complete" &&
          !anchor.deletion_job &&
          anchor.sha256_hex === m.anchor.sha256,
        "storage_collection_invalid",
        409,
      );
      const [payload] =
        await tx`SELECT 1 FROM managed_storage_refs WHERE object_id=${anchor.id} AND role='payload' LIMIT 1`;
      requireCondition(!payload, "storage_anchor_role_conflict", 409);
      const [old] =
        await tx`SELECT * FROM managed_storage_sets WHERE workspace_id=${g.workspaceId} AND delegation_id=${g.delegationId} AND id=${m.set_id}`;
      if (old) {
        requireCondition(
          digest(JSON.stringify(collectionMetadata(old.metadata))) ===
            digest(JSON.stringify(m)) &&
            old.membership_digest === input.membership_digest &&
            old.state !== "aborted",
          "storage_idempotency_conflict",
          409,
        );
        return {
          set_id: m.set_id,
          state: old.state,
          membership_digest: old.membership_digest,
        };
      }
      const bytes = Buffer.byteLength(JSON.stringify(m)) + 4096;
      await this.budget(g, bytes, tx);
      await tx`INSERT INTO managed_storage_sets VALUES(${g.workspaceId},${g.delegationId},${m.set_id},${tx.json(m)},${input.membership_digest},${m.total_count},'draft',${bytes})`;
      await this.bump(g, tx);
      return {
        set_id: m.set_id,
        state: "draft",
        membership_digest: input.membership_digest,
      };
    });
  }
  async pagePut(g: StorageGrant, id: string, input: any) {
    const refs = collectionRefs(input.refs),
      page = Number(input.page);
    requireCondition(
      Number.isInteger(page) && page >= 0 && page < 2000,
      "storage_collection_invalid",
    );
    return this.locked(g, async (tx) => {
      const s = await this.set(g, id, tx);
      requireCondition(
        page < Math.ceil(s.total_count / 50) &&
          refs.length === Math.min(50, s.total_count - page * 50),
        "storage_collection_invalid",
      );
      const [old] =
        await tx`SELECT refs FROM managed_storage_set_pages WHERE workspace_id=${g.workspaceId} AND delegation_id=${g.delegationId} AND set_id=${id} AND page=${page}`;
      if (old) {
        requireCondition(
          JSON.stringify(collectionRefs(old.refs)) === JSON.stringify(refs),
          "storage_idempotency_conflict",
          409,
        );
        return { set_id: id, state: s.state, page };
      }
      requireCondition(s.state === "draft", "storage_collection_sealed", 409);
      const bytes = Buffer.byteLength(JSON.stringify(refs)) + 128;
      await this.budget(g, bytes, tx);
      await tx`INSERT INTO managed_storage_set_pages VALUES(${g.workspaceId},${g.delegationId},${id},${page},${tx.json(refs)})`;
      await tx`UPDATE managed_storage_sets SET metadata_bytes=metadata_bytes+${bytes} WHERE workspace_id=${g.workspaceId} AND delegation_id=${g.delegationId} AND id=${id}`;
      await this.bump(g, tx);
      return { set_id: id, state: "draft", page };
    });
  }
  async seal(g: StorageGrant, id: string) {
    return this.locked(g, async (tx) => {
      const s = await this.set(g, id, tx);
      if (s.state === "sealed")
        return {
          set_id: id,
          state: s.state,
          membership_digest: s.membership_digest,
        };
      requireCondition(s.state === "draft", "storage_collection_sealed", 409);
      const refs = sortedRefs(await this.refs(g, id, tx));
      requireCondition(
        refs.length === s.total_count &&
          new Set(refs.map((r) => r.object_id)).size === refs.length &&
          new Set(refs.map((r) => JSON.stringify([r.name, r.part]))).size ===
            refs.length &&
          membershipDigest(s.metadata, refs) === s.membership_digest,
        "storage_collection_incomplete",
        409,
      );
      const ids = refs.map((r) => r.object_id);
      const objects =
        await tx`SELECT * FROM managed_app_storage_objects WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
      const byId = new Map(objects.map((r: any) => [r.id, r]));
      for (const ref of refs) {
        const r: any = byId.get(ref.object_id);
        requireCondition(
          r &&
            r.workspace_id === g.workspaceId &&
            r.delegation_id === g.delegationId &&
            r.installation_id === g.installationId &&
            r.app_id === g.appId &&
            r.app_npub === g.appNpub &&
            r.state === "complete" &&
            !r.deletion_job &&
            r.sha256_hex === ref.sha256 &&
            Number(r.size_bytes) === ref.bytes &&
            r.id !== s.metadata.anchor.object_id,
          "storage_collection_invalid",
          409,
        );
      }
      const [anchorConflict] =
        await tx`SELECT 1 FROM managed_storage_refs WHERE object_id=ANY(${ids}::uuid[]) AND role='anchor' LIMIT 1`;
      requireCondition(!anchorConflict, "storage_anchor_role_conflict", 409);
      const anchor = await this.ledger.object(
        g,
        s.metadata.anchor.object_id,
        tx,
        true,
      );
      requireCondition(
        !anchor.deletion_job &&
          anchor.state === "complete" &&
          anchor.sha256_hex === s.metadata.anchor.sha256,
        "storage_collection_invalid",
        409,
      );
      // Insert in bounded chunks; transaction seals the entire membership atomically.
      for (let i = 0; i < refs.length; i += 500) {
        const rows = refs.slice(i, i + 500).map((r) => ({
          workspace_id: g.workspaceId,
          delegation_id: g.delegationId,
          set_id: id,
          object_id: r.object_id,
          role: "payload",
        }));
        await tx`INSERT INTO managed_storage_refs ${tx(rows)}`;
      }
      await tx`INSERT INTO managed_storage_refs VALUES(${g.workspaceId},${g.delegationId},${id},${anchor.id},'anchor')`;
      await tx`UPDATE managed_storage_sets SET state='sealed' WHERE workspace_id=${g.workspaceId} AND delegation_id=${g.delegationId} AND id=${id}`;
      await this.bump(g, tx);
      return {
        set_id: id,
        state: "sealed",
        membership_digest: s.membership_digest,
      };
    });
  }
  async abort(g: StorageGrant, id: string) {
    return this.locked(g, async (tx) => {
      const s = await this.set(g, id, tx);
      requireCondition(
        s.state === "draft" || s.state === "aborted",
        "storage_collection_sealed",
        409,
      );
      if (s.state === "draft") {
        await tx`UPDATE managed_storage_sets SET state='aborted' WHERE workspace_id=${g.workspaceId} AND delegation_id=${g.delegationId} AND id=${id}`;
        await this.bump(g, tx);
      }
      return { set_id: id, state: "aborted" };
    });
  }
  async status(g: StorageGrant, id: string, page = 0) {
    await this.service.recheck(g);
    const s = await this.set(g, id, this.ledger.db);
    const [p] = await this.ledger
      .db`SELECT refs FROM managed_storage_set_pages WHERE workspace_id=${g.workspaceId} AND delegation_id=${g.delegationId} AND set_id=${id} AND page=${page}`;
    const [job] = await this.ledger
      .db`SELECT id,digest,confirmation_receipt FROM managed_storage_previews WHERE workspace_id=${g.workspaceId} AND delegation_id=${g.delegationId} AND set_id=${id} AND state='confirmed'`;
    return {
      set_id: id,
      metadata: s.metadata,
      state: s.state,
      membership_digest: s.membership_digest,
      refs: p?.refs ?? [],
      page,
      next_page: (page + 1) * 50 < s.total_count ? page + 1 : null,
      job: job ?? null,
    };
  }
  async list(g: StorageGrant, page = 0) {
    await this.service.recheck(g);
    const rows = await this.ledger
      .db`SELECT id,metadata,state,membership_digest FROM managed_storage_sets WHERE workspace_id=${g.workspaceId} AND delegation_id=${g.delegationId} ORDER BY id LIMIT 6 OFFSET ${page * 5}`;
    for (const s of rows)
      await this.ledger.object(g, s.metadata.anchor.object_id);
    return {
      sets: rows.slice(0, 5),
      next_page: rows.length > 5 ? page + 1 : null,
    };
  }
  async safe(g: StorageGrant, tx: any) {
    const [draft] =
      await tx`SELECT id FROM managed_storage_sets WHERE workspace_id=${g.workspaceId} AND delegation_id=${g.delegationId} AND state='draft' LIMIT 1`;
    requireCondition(!draft, "storage_unsealed_collection_blocks_delete", 409);
    const [unknown] =
      await tx`SELECT o.id FROM managed_app_storage_objects o WHERE o.workspace_id=${g.workspaceId} AND o.delegation_id=${g.delegationId}
   AND (o.state<>'complete' OR NOT EXISTS(SELECT 1 FROM managed_storage_refs r WHERE r.object_id=o.id)) LIMIT 1`;
    requireCondition(
      !unknown,
      "storage_unregistered_objects_block_delete",
      409,
    );
  }
  async snapshot(g: StorageGrant, id: string) {
    return this.locked(g, async (tx) => {
      const s = await this.set(g, id, tx);
      requireCondition(
        s.state === "sealed",
        "storage_collection_not_active",
        409,
      );
      await this.safe(g, tx);
      const refs = sortedRefs(await this.refs(g, id, tx)),
        ids = refs.map((r) => r.object_id);
      const protectedRows =
        await tx`SELECT DISTINCT r.object_id FROM managed_storage_refs r JOIN managed_storage_sets s ON s.workspace_id=r.workspace_id AND s.delegation_id=r.delegation_id AND s.id=r.set_id
   WHERE r.object_id=ANY(${ids}::uuid[]) AND (r.role='anchor' OR (r.set_id<>${id} AND s.state='sealed'))`;
      const retainedIds = new Set(protectedRows.map((r: any) => r.object_id));
      const objects = refs.map((r) => ({
        ...r,
        disposition: retainedIds.has(r.object_id)
          ? "retained_shared"
          : "delete_payload",
      }));
      const anchor = await this.ledger.object(
        g,
        s.metadata.anchor.object_id,
        tx,
      );
      const snapshot = {
        set_id: id,
        metadata: s.metadata,
        membership_digest: s.membership_digest,
        revision: await this.revision(g, tx),
        grant_revision: g.revision,
        destination: {
          origin: g.origin,
          service_npub: g.serviceNpub,
          workspace_id: g.workspaceId,
          delegation_id: g.delegationId,
          installation_id: g.installationId,
          app_id: g.appId,
          app_npub: g.appNpub,
        },
        objects,
        anchor_bytes: Number(anchor.size_bytes),
        retained_bytes: objects
          .filter((r) => r.disposition === "retained_shared")
          .reduce((n, r) => n + r.bytes, Number(anchor.size_bytes)),
        delete_bytes: objects
          .filter((r) => r.disposition === "delete_payload")
          .reduce((n, r) => n + r.bytes, 0),
        expires_at: new Date(
          Math.min(this.service.now() + 900000, Date.parse(g.expiresAt)),
        ).toISOString(),
      };
      const hash = digest(canonical(snapshot)),
        previewId = randomUUID(),
        bytes = Buffer.byteLength(JSON.stringify(snapshot)) * 2 + 8192;
      // Unconfirmed preview cache is bounded/reclaimed independently of payload quota,
      // so a full destination can still authorize cleanup. Confirmed evidence remains charged.
      await tx`DELETE FROM managed_storage_previews WHERE workspace_id=${g.workspaceId} AND delegation_id=${g.delegationId}
       AND state<>'confirmed' AND (state='cancelled' OR expires_at<=${new Date(this.service.now())} OR set_id=${id})`;
      const [active] =
        await tx`SELECT COUNT(*)::int AS count FROM managed_storage_previews WHERE workspace_id=${g.workspaceId} AND delegation_id=${g.delegationId} AND state='preview' AND expires_at>${new Date(this.service.now())}`;
      requireCondition(active.count < 3, "storage_preview_limit", 429);
      await tx`INSERT INTO managed_storage_previews(id,workspace_id,delegation_id,set_id,snapshot,digest,graph_revision,grant_revision,expires_at,metadata_bytes)
   VALUES(${previewId},${g.workspaceId},${g.delegationId},${id},${tx.json(snapshot)},${hash},${snapshot.revision},${g.revision},${snapshot.expires_at},${bytes})`;
      return { preview_id: previewId, digest: hash, ...this.summary(snapshot) };
    });
  }
  summary(s: any) {
    const { objects, ...summary } = s;
    return { ...summary, total_count: objects.length };
  }
  async preview(g: StorageGrant, id: string, tx: any, active = true) {
    const [p] =
      await tx`SELECT * FROM managed_storage_previews WHERE id=${id} AND workspace_id=${g.workspaceId} AND delegation_id=${g.delegationId}`;
    requireCondition(p, "storage_preview_not_found", 404);
    await this.set(g, p.set_id, tx);
    if (active)
      requireCondition(
        p.state === "preview" &&
          p.expires_at.getTime() > this.service.now() &&
          p.grant_revision === g.revision &&
          p.graph_revision === (await this.revision(g, tx)),
        "storage_preview_stale",
        409,
      );
    return p;
  }
  async previewPage(g: StorageGrant, id: string, page: number) {
    return this.locked(g, async (tx) => {
      const p = await this.preview(g, id, tx, false);
      if (p.state !== "confirmed") await this.preview(g, id, tx);
      const objects = p.snapshot.objects.slice(page * 25, (page + 1) * 25);
      return {
        preview_id: id,
        digest: p.digest,
        ...this.summary(p.snapshot),
        objects,
        page,
        next_page:
          (page + 1) * 25 < p.snapshot.objects.length ? page + 1 : null,
      };
    });
  }
  async arm(g: StorageGrant, id: string, hash: string) {
    return this.locked(g, async (tx) => {
      const p = await this.preview(g, id, tx);
      requireCondition(p.digest === hash, "storage_preview_stale", 409);
      const token = randomBytes(32).toString("base64url"),
        expires = new Date(
          Math.min(this.service.now() + 120000, p.expires_at.getTime()),
        );
      await tx`UPDATE managed_storage_previews SET token_digest=${digest(token)},token_expires_at=${expires} WHERE id=${id}`;
      return {
        preview_id: id,
        digest: hash,
        confirmation_token: token,
        confirmation_expires_at: expires.toISOString(),
      };
    });
  }
  async cancel(g: StorageGrant, id: string) {
    return this.locked(g, async (tx) => {
      const p = await this.preview(g, id, tx, false);
      requireCondition(
        p.state === "preview" || p.state === "cancelled",
        "storage_confirmation_used",
        409,
      );
      await tx`UPDATE managed_storage_previews SET state='cancelled',token_digest=NULL,snapshot='{}'::jsonb,metadata_bytes=0 WHERE id=${id}`;
      return { preview_id: id, state: "cancelled" };
    });
  }
  async confirm(
    g: StorageGrant,
    id: string,
    input: any,
    receipt: PublisherReceipt,
  ) {
    return this.locked(g, async (tx) => {
      const p = await this.preview(g, id, tx);
      await this.safe(g, tx);
      requireCondition(
        typeof input.confirmation_token === "string" &&
          tokenPattern.test(input.confirmation_token) &&
          p.token_digest === digest(input.confirmation_token) &&
          p.token_expires_at?.getTime() > this.service.now() &&
          input.digest === p.digest &&
          input.set_id === p.set_id &&
          input.anchor_sha256 === p.snapshot.metadata.anchor.sha256 &&
          input.membership_digest === p.snapshot.membership_digest &&
          input.total_count === p.snapshot.objects.length &&
          input.graph_revision === p.graph_revision &&
          input.snapshot_expires_at === p.snapshot.expires_at &&
          input.confirmation_expires_at === p.token_expires_at.toISOString(),
        "storage_confirmation_invalid",
        409,
      );
      const selected = p.snapshot.objects.filter(
          (r: any) => r.disposition === "delete_payload",
        ),
        ids = selected.map((r: any) => r.object_id);
      if (ids.length) {
        const objects =
          await tx`SELECT * FROM managed_app_storage_objects WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
        requireCondition(
          objects.length === ids.length &&
            objects.every((r: any) => !r.deletion_job),
          "storage_preview_stale",
          409,
        );
        await tx`UPDATE managed_app_storage_objects SET deletion_job=${id},upload_digest=NULL,download_digest=NULL WHERE id=ANY(${ids}::uuid[])`;
        for (let i = 0; i < ids.length; i += 500)
          await tx`INSERT INTO managed_storage_delete_items ${tx(ids.slice(i, i + 500).map((object_id: string) => ({ job_id: id, object_id })))}`;
      }
      await tx`UPDATE managed_storage_sets SET state='deleted' WHERE workspace_id=${g.workspaceId} AND delegation_id=${g.delegationId} AND id=${p.set_id}`;
      await tx`UPDATE managed_storage_previews SET state='confirmed',token_digest=NULL,confirmation_receipt=${tx.json(receipt as never)} WHERE id=${id}`;
      await this.bump(g, tx);
      return {
        job_id: id,
        state: "confirmed",
        logical_deleted: true,
        physical_complete: ids.length === 0,
      };
    });
  }
  async job(g: StorageGrant, id: string) {
    await this.service.recheck(g);
    const p = await this.preview(g, id, this.ledger.db, false);
    requireCondition(p.state === "confirmed", "storage_job_not_found", 404);
    const [r] = await this.ledger
      .db`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE state='physical_absent')::int done FROM managed_storage_delete_items WHERE job_id=${id}`;
    return {
      job_id: id,
      state: "confirmed",
      logical_deleted: true,
      physical_complete: r.total === r.done,
      total_objects: r.total,
      physical_absent_objects: r.done,
      set_id: p.set_id,
      digest: p.digest,
      confirmation_receipt: p.confirmation_receipt,
    };
  }
  async resume(g: StorageGrant, id: string, signal: AbortSignal) {
    await this.job(g, id);
    requireCondition(
      this.service.options.blobs.removeVerified,
      "storage_physical_delete_unsupported",
      409,
    );
    // A short per-job database transaction locks progress against another process. No delegation lock spans provider IO.
    await this.ledger.transaction(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`managed-delete:${id}`}))`;
      await this.service.recheck(g, false, tx);
      const [item] =
        await tx`SELECT * FROM managed_storage_delete_items WHERE job_id=${id} AND state='pending' ORDER BY object_id LIMIT 1 FOR UPDATE`;
      if (!item) return;
      const object = await this.ledger.object(g, item.object_id, tx, true);
      requireCondition(object.deletion_job === id, "storage_job_conflict", 409);
      await this.service.options.blobs.removeVerified!(
        objectKey(object),
        signal,
      );
      await this.service.recheck(g, false, tx);
      signal.throwIfAborted();
      await tx`UPDATE managed_app_storage_objects SET physical_absent=true WHERE id=${object.id} AND deletion_job=${id}`;
      await tx`UPDATE managed_storage_delete_items SET state='physical_absent' WHERE job_id=${id} AND object_id=${object.id}`;
    });
    return this.job(g, id);
  }
}
