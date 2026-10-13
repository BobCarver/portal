import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { AppContext } from "../src/context.ts";
import { connect, migrate } from "../src/db.ts";
import { MemoryMailer } from "../src/mail.ts";
import { DiskStorage } from "../src/storage.ts";

export const TEST_DATABASE_URL = Deno.env.get("TEST_DATABASE_URL") ??
  "postgres://postgres@localhost:5544/portal_test";

/** Is the test database reachable? Integration tests are skipped when not. */
export async function databaseAvailable(): Promise<boolean> {
  const sql = connect(TEST_DATABASE_URL, { max: 1 });
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    console.warn(
      `integration tests skipped: no database at ${TEST_DATABASE_URL} (deno task db:start)`,
    );
    return false;
  } finally {
    await sql.end();
  }
}

/** A clean schema, temporary storage and an in-process app. */
export async function testContext(
  env: Record<string, string> = {},
): Promise<
  { ctx: AppContext & { mailer: MemoryMailer }; cleanup: () => Promise<void> }
> {
  const dir = await Deno.makeTempDir({ prefix: "portal-test-" });
  const config = loadConfig((n) =>
    ({
      DATABASE_URL: TEST_DATABASE_URL,
      STORAGE_DIR: `${dir}/storage`,
      EXPORT_DIR: `${dir}/exports`,
      BASE_URL: "http://portal.test",
      ...env,
    })[n]
  );
  const sql = connect(config.databaseUrl, { max: 4 });
  await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(sql);
  await Deno.mkdir(config.exportDir, { recursive: true });
  const ctx = {
    config,
    sql,
    storage: new DiskStorage(config.storageDir),
    mailer: new MemoryMailer(),
  };
  return {
    ctx,
    cleanup: async () => {
      await sql.end();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    },
  };
}

/** A browser-ish client for the in-process app: keeps cookies, sends Origin. */
export class Client {
  cookies = new Map<string, string>();
  private fetch: (req: Request) => Response | Promise<Response>;
  constructor(ctx: AppContext) {
    const app = createApp(ctx);
    this.fetch = (req) => app.fetch(req);
  }

  async request(
    method: string,
    path: string,
    opts: {
      form?: Record<string, string> | FormData;
      headers?: Record<string, string>;
      body?: BodyInit;
    } = {},
  ): Promise<Response> {
    const headers = new Headers(opts.headers);
    if (!headers.has("origin")) headers.set("origin", "http://portal.test");
    // Browsers send the page the form was on; errors redirect back to it.
    if (method === "POST" && !headers.has("referer")) {
      headers.set("referer", `http://portal.test${path}`);
    }
    if (this.cookies.size) {
      headers.set(
        "cookie",
        [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      );
    }
    let body = opts.body;
    if (opts.form instanceof FormData) body = opts.form;
    else if (opts.form) body = new URLSearchParams(opts.form);
    const res = await this.fetch(
      new Request(`http://portal.test${path}`, {
        method,
        headers,
        body,
        redirect: "manual",
      }),
    );
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, v] = pair.split("=");
      if (/max-age=0/i.test(c) || v === "") this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    return res;
  }

  get(path: string) {
    return this.request("GET", path);
  }
  post(path: string, form: Record<string, string> | FormData = {}) {
    return this.request("POST", path, { form });
  }
}

/** Where a 303 went, with its flash message. */
export function redirected(
  res: Response,
): { path: string; ok: string | null; err: string | null } {
  const loc = res.headers.get("location") ?? "";
  const u = new URL(loc, "http://portal.test");
  return {
    path: u.pathname,
    ok: u.searchParams.get("ok"),
    err: u.searchParams.get("err"),
  };
}

/** A short WAV made by ffmpeg (a sine tone, or silence). */
export async function makeWav(
  seconds = 2,
  kind: "tone" | "silence" = "tone",
): Promise<Uint8Array> {
  const src = kind === "tone"
    ? `sine=frequency=330:duration=${seconds}`
    : `anullsrc=r=44100:cl=mono`;
  const out = await new Deno.Command("ffmpeg", {
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      src,
      "-t",
      String(seconds),
      "-af",
      "volume=-20dB",
      "-f",
      "wav",
      "-",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return out.stdout;
}
