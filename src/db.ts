import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;
/** A connection or a transaction: what most queries take. */
export type Tx = Sql | postgres.TransactionSql;

export function connect(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => {},
    // BIGSERIAL ids fit easily in a JS number; return them as numbers.
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number) => x.toString(),
        parse: (x: string) => Number(x),
      },
    },
  });
}

/** Hide the password in a connection URL before logging it. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable DATABASE_URL>";
  }
}

/**
 * Apply every `db/NNN_*.sql` not applied yet, in name order, each in its own
 * transaction. Applied names are kept in `schema_migrations`.
 */
export async function migrate(
  sql: Sql,
  dir = new URL("../db/", import.meta.url),
): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  const done = new Set(
    (await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((
      r,
    ) => r.name),
  );
  const files: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && /^\d+_.*\.sql$/.test(e.name)) files.push(e.name);
  }
  const applied: string[] = [];
  for (const name of files.sort()) {
    if (done.has(name)) continue;
    const text = await Deno.readTextFile(new URL(name, dir));
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
    });
    applied.push(name);
  }
  return applied;
}

/** Record something worth seeing later (exports, jobs, freezes). */
export async function logEvent(
  sql: Tx,
  e: {
    festivalId?: number | null;
    userId?: number | null;
    kind: string;
    detail?: string;
  },
): Promise<void> {
  await sql`INSERT INTO events (festival_id, user_id, kind, detail)
    VALUES (${e.festivalId ?? null}, ${e.userId ?? null}, ${e.kind}, ${
    e.detail ?? ""
  })`;
  console.log(`[${e.kind}]`, e.festivalId ?? "", e.detail ?? "");
}
