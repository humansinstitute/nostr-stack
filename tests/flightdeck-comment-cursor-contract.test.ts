import { expect, test } from "bun:test";
import { listFlightDeckPgTaskComments, listFlightDeckPgDocComments } from "../src/services/flightdeck-pg-api";
type DbClient = NonNullable<Parameters<typeof listFlightDeckPgTaskComments>[1]>;

// Capture the real SQL boundary: postgres.js infers parameter OIDs from SQL.
// A timestamptz OID invokes Date serialization, which truncates microseconds;
// a text OID preserves the opaque cursor timestamp for PostgreSQL to cast.
for (const kind of ["task", "doc"] as const) {
  test(`${kind} comment cursor uses text parameters to retain exact microseconds`, async () => {
    let fragments: string[] = [];
    let values: unknown[] = [];
    const sql = ((strings: TemplateStringsArray, ...parameters: unknown[]) => {
      fragments = [...strings]; values = parameters;
      return Promise.resolve([]);
    }) as unknown as DbClient;
    const stamp = "2026-11-07 23:50:21.742883+00";
    const id = "00f44732-64a7-4d2a-b293-3836f8f59e13";
    const input = { workspaceId: "workspace", limit: 2, afterCreatedAt: stamp, afterId: id };
    if (kind === "task") await listFlightDeckPgTaskComments({ ...input, taskId: "task" }, sql);
    else await listFlightDeckPgDocComments({ ...input, docId: "doc" }, sql);
    const timestampIndexes = values.flatMap((value, index) => value === stamp ? [index] : []);
    expect(timestampIndexes).toHaveLength(2);
    for (const index of timestampIndexes) expect(fragments[index + 1]).toStartWith("::text::timestamptz");
    expect(values).toContain(id);
    expect(fragments.join("?")).toContain(`(${kind === "task" ? "tc" : "dc"}.created_at,${kind === "task" ? "tc" : "dc"}.id)>`);
    // This is the data loss the old inferred timestamptz serializer caused.
    expect(new Date(stamp).toISOString()).toBe("2026-11-07T23:50:21.742Z");
  });
}
