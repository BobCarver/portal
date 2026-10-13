import type { Hono } from "@hono/hono";
import { bodyLimit } from "@hono/hono/body-limit";
import { audioFileName, type BundleManifest } from "festival-bundle";
import { join } from "node:path";
import type { AppEnv, C } from "../app.ts";
import type { AppContext } from "../context.ts";
import { sha256Hex } from "../crypto.ts";
import { logEvent } from "../db.ts";
import { UserError } from "../errors.ts";
import { writeStoredZip } from "../export/zip.ts";
import { fileResponse } from "../http.ts";
import { receiveScores } from "../scores.ts";

/**
 * The venue's API, authenticated by the per-festival token
 * (`Authorization: Bearer <token>`) and logged:
 *
 *   POST /api/scores                          score snapshot push (section 9)
 *   GET  /api/bundle                          which bundle to fetch (final, else latest)
 *   GET  /api/bundle/:id/manifest.json        distribution B (section 8):
 *   GET  /api/bundle/:id/data.json              the manifest first, then only
 *   GET  /api/bundle/:id/audio/<sha256>.mp3     the hashes the venue lacks,
 *   GET  /api/bundle/:id/bundle.zip             with HTTP Range for resuming
 */

async function festivalForToken(ctx: AppContext, c: C): Promise<number> {
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
  if (!m) throw new UserError("missing bearer token", 403);
  const [f] = await ctx.sql<{ id: number }[]>`
    SELECT id FROM festivals WHERE api_token_hash = ${await sha256Hex(m[1])}`;
  if (!f) {
    console.warn(
      `api: bad token from ${
        c.req.header("x-forwarded-for") ?? "client"
      } on ${c.req.path}`,
    );
    throw new UserError("invalid token", 403);
  }
  return f.id;
}

/** A zip with only manifest.json and data.json: enough when the venue holds every hash. */
export async function dataOnlyZip(
  name: string,
  manifestText: string,
  dataText: string,
  generatedAt: Date,
): Promise<Uint8Array<ArrayBuffer>> {
  const dir = await Deno.makeTempDir({ prefix: "portal-zip-" });
  try {
    const path = join(dir, "bundle.zip");
    const enc = new TextEncoder();
    await writeStoredZip(path, [
      { name: `${name}/manifest.json`, data: enc.encode(manifestText) },
      { name: `${name}/data.json`, data: enc.encode(dataText) },
    ], generatedAt);
    return await Deno.readFile(path);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

export function apiRoutes(app: Hono<AppEnv>, ctx: AppContext) {
  app.post(
    "/api/scores",
    bodyLimit({
      maxSize: ctx.config.maxScoreBodyBytes,
      onError: (c) => c.json({ ok: false, error: "push too large" }, 413),
    }),
    async (c) => {
      const festivalId = await festivalForToken(ctx, c);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ ok: false, error: "body is not JSON" }, 400);
      }
      const r = await receiveScores(ctx, festivalId, body);
      return c.json(r.body, r.status);
    },
  );

  const exportFor = async (festivalId: number, exportId?: number) => {
    const [x] = exportId
      ? await ctx.sql<
        {
          id: number;
          final: boolean;
          folder: string;
          digest: string;
          generated_at: Date;
          manifest_text: string;
          data_text: string;
        }[]
      >`
          SELECT id, final, folder, digest, generated_at, manifest_text, data_text FROM exports
          WHERE id = ${exportId} AND festival_id = ${festivalId}`
      : await ctx.sql<
        {
          id: number;
          final: boolean;
          folder: string;
          digest: string;
          generated_at: Date;
          manifest_text: string;
          data_text: string;
        }[]
      >`
          SELECT id, final, folder, digest, generated_at, manifest_text, data_text FROM exports
          WHERE festival_id = ${festivalId} ORDER BY final DESC, generated_at DESC LIMIT 1`;
    if (!x) throw new UserError("no such bundle", 404);
    return x;
  };

  app.get("/api/bundle", async (c) => {
    const festivalId = await festivalForToken(ctx, c);
    const x = await exportFor(festivalId);
    return c.json({
      export_id: x.id,
      final: x.final,
      digest: x.digest,
      generated_at: x.generated_at.toISOString(),
      manifest_url: `/api/bundle/${x.id}/manifest.json`,
    });
  });

  app.on(["GET", "HEAD"], "/api/bundle/:id/*", async (c) => {
    const festivalId = await festivalForToken(ctx, c);
    const x = await exportFor(festivalId, Number(c.req.param("id")));
    const rest = c.req.path.split(`/api/bundle/${c.req.param("id")}/`)[1] ?? "";
    await logEvent(ctx.sql, {
      festivalId,
      kind: "api.bundle",
      detail: `export ${x.id} ${rest}${
        c.req.header("range") ? ` ${c.req.header("range")}` : ""
      }`,
    });
    if (rest === "manifest.json") {
      return c.body(x.manifest_text, 200, {
        "content-type": "application/json",
      });
    }
    if (rest === "data.json") {
      return c.body(x.data_text, 200, { "content-type": "application/json" });
    }
    if (rest === "bundle.zip") {
      return fileResponse(c.req.raw, `${x.folder}.zip`, {
        "content-type": "application/zip",
      });
    }
    const m = /^audio\/([0-9a-f]{64}\.(mp3|wav))$/.exec(rest);
    if (m) {
      const manifest = JSON.parse(x.manifest_text) as BundleManifest;
      if (!manifest.audio.some((a) => audioFileName(a) === m[1])) {
        throw new UserError("not in this bundle", 404);
      }
      return fileResponse(c.req.raw, join(x.folder, "audio", m[1]), {
        "content-type": m[2] === "mp3" ? "audio/mpeg" : "audio/wav",
        "cache-control": "private, max-age=31536000, immutable",
      });
    }
    throw new UserError("not found", 404);
  });
}
