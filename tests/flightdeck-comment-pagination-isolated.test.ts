import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { listFlightDeckPgTaskComments, listFlightDeckPgDocComments } from "../src/services/flightdeck-pg-api";

// Opt in only with a disposable database. No host/runtime credential fallback.
const connection = process.env.FLIGHTDECK_CURSOR_TEST_DATABASE_URL;
const suite = connection ? test : test.skip;
let sql: ReturnType<typeof postgres>;
const w = "11111111-1111-4111-8111-111111111111";
const parent = "22222222-2222-4222-8222-222222222222";
const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
beforeAll(async () => {
  if (!connection) return;
  sql = postgres(connection, { max: 1 });
  // Temporary tables shadow no persistent schema and disappear on disconnect.
  await sql`CREATE TEMP TABLE flightdeck_pg_actors (id uuid, npub text)`;
  await sql`CREATE TEMP TABLE flightdeck_pg_task_comments (id uuid, workspace_id uuid, task_id uuid, created_at timestamptz, created_by_actor_id uuid, deleted_at timestamptz)`;
  await sql`CREATE TEMP TABLE flightdeck_pg_doc_comments (id uuid, workspace_id uuid, doc_id uuid, created_at timestamptz, created_by_actor_id uuid, deleted_at timestamptz)`;
  for (const table of ["flightdeck_pg_task_comments", "flightdeck_pg_doc_comments"]) {
    const key = table.includes("task") ? "task_id" : "doc_id";
    for (const [index, id] of ids.entries()) {
      const stamp = index < 2 ? "2026-11-07 23:50:21.742883+00" : "2026-11-07 23:50:21.742884+00";
      await sql`INSERT INTO ${sql(table)} (id, workspace_id, ${sql(key)}, created_at) VALUES (${id}, ${w}, ${parent}, ${stamp}::text::timestamptz)`;
    }
  }
});
afterAll(async () => { if (sql) await sql.end(); });

suite("driver's inferred timestamptz binding reproduces microsecond loss", async () => {
  const stamp = "2026-11-07 23:50:21.742883+00";
  const [legacy] = await sql`SELECT ${stamp}::timestamptz::text AS stamp`;
  expect(legacy!.stamp).not.toContain("742883");
  const [fixed] = await sql`SELECT ${stamp}::text::timestamptz::text AS stamp`;
  expect(fixed!.stamp).toContain("742883");
});

for (const kind of ["task", "doc"] as const) suite(`${kind} consumer traverses equal timestamp IDs and adjacent microseconds exactly once`, async () => {
  let cursor: { afterCreatedAt?: string; afterId?: string } = {};
  const seen: string[] = [];
  for (let page = 0; page < 4; page++) {
    const input = { workspaceId: w, limit: 1, ...cursor };
    const rows = kind === "task" ? await listFlightDeckPgTaskComments({ ...input, taskId: parent }, sql) : await listFlightDeckPgDocComments({ ...input, docId: parent }, sql);
    if (!rows.length) break;
    const row = rows[0]! as typeof rows[number] & { cursor_created_at: string };
    seen.push(row.id);
    cursor = { afterCreatedAt: row.cursor_created_at, afterId: row.id };
  }
  expect(seen).toEqual(ids);
});
