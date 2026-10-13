import type { AppContext } from "../context.ts";
import { sha256Hex } from "../crypto.ts";
import { logEvent } from "../db.ts";
import { AudioRejected, normalise } from "./loudnorm.ts";

/**
 * The normalisation worker: takes jobs from `audio_jobs` (a table-backed queue,
 * `FOR UPDATE SKIP LOCKED`, so several workers would not collide) and turns a
 * `processing` file into `ready` or `failed`.
 */

const MAX_ATTEMPTS = 3;
const STALE_AFTER = "15 minutes";

interface Job {
  id: number;
  audio_file_id: number;
  attempts: number;
}

/** Claim the next due job, or null. Also re-queues jobs a dead worker left. */
async function claim(ctx: AppContext): Promise<Job | null> {
  await ctx.sql`
    UPDATE audio_jobs SET status = 'queued', locked_at = NULL
    WHERE status = 'running' AND locked_at < now() - ${STALE_AFTER}::interval`;
  const [job] = await ctx.sql<Job[]>`
    UPDATE audio_jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM audio_jobs
      WHERE status = 'queued' AND run_after <= now()
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id, audio_file_id, attempts`;
  return job ?? null;
}

/** Run one job if one is due. True if a job was run. */
export async function runOne(ctx: AppContext): Promise<boolean> {
  const job = await claim(ctx);
  if (!job) return false;
  await runJob(ctx, job);
  return true;
}

/** Run jobs until none is due (tests, scripts). */
export async function drain(ctx: AppContext): Promise<number> {
  let n = 0;
  while (await runOne(ctx)) n++;
  return n;
}

async function runJob(ctx: AppContext, job: Job): Promise<void> {
  const [file] = await ctx.sql<
    {
      id: number;
      kind: "music" | "announce";
      original_key: string;
      festival_id: number;
      entry_id: number;
    }[]
  >`
    SELECT a.id, a.kind, a.original_key, a.entry_id, c.festival_id
    FROM audio_files a JOIN entries e ON e.id = a.entry_id
      JOIN competitions c ON c.id = e.competition_id
    WHERE a.id = ${job.audio_file_id}`;
  if (!file) {
    // Replaced or withdrawn meanwhile (the job row would be gone too, normally).
    await ctx
      .sql`UPDATE audio_jobs SET status = 'done', finished_at = now() WHERE id = ${job.id}`;
    return;
  }
  const a = ctx.config.audio;
  const target = file.kind === "music" ? a.musicLufs : a.announceLufs;
  const dir = await Deno.makeTempDir({ prefix: "portal-audio-" });
  const started = Date.now();
  try {
    const out = `${dir}/out.mp3`;
    const result = await ctx.storage.withLocalPath(
      file.original_key,
      (input) =>
        normalise(input, out, {
          targetLufs: target,
          truePeakDb: a.truePeakDb,
          lra: a.lra,
          bitrate: a.bitrate,
          sampleRate: a.sampleRate,
        }),
    );
    const bytes = await Deno.readFile(out);
    const sha = await sha256Hex(bytes);
    const key = `normalised/${sha}.mp3`;
    if (await ctx.storage.exists(key)) await Deno.remove(out);
    else await ctx.storage.putFile(key, out);

    await ctx.sql.begin(async (tx) => {
      await tx`
        UPDATE audio_files SET status = 'ready', reason = NULL, storage_key = ${key},
          sha256 = ${sha}, bytes = ${bytes.length}, content_type = 'audio/mpeg',
          target_lufs = ${target}, lufs = ${result.lufs},
          true_peak_db = ${result.truePeakDb}, flag = ${result.flag},
          processed_at = now()
        WHERE id = ${file.id} AND status = 'processing'`;
      await tx`UPDATE audio_jobs SET status = 'done', finished_at = now(), error = NULL
        WHERE id = ${job.id}`;
      await logEvent(tx, {
        festivalId: file.festival_id,
        kind: "audio.ready",
        detail: `file ${file.id} (entry ${file.entry_id} ${file.kind}): ` +
          `${result.lufs ?? "-"} LUFS, ${result.truePeakDb ?? "-"} dBTP, ` +
          `${result.mode}, ${Date.now() - started} ms` +
          (result.flag ? `; flag: ${result.flag}` : ""),
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const final = err instanceof AudioRejected || job.attempts >= MAX_ATTEMPTS;
    await ctx.sql.begin(async (tx) => {
      if (final) {
        await tx`UPDATE audio_files SET status = 'failed', reason = ${message},
            processed_at = now()
          WHERE id = ${file.id} AND status = 'processing'`;
        await tx`UPDATE audio_jobs SET status = 'failed', error = ${message},
            finished_at = now() WHERE id = ${job.id}`;
      } else {
        await tx`UPDATE audio_jobs SET status = 'queued', error = ${message},
            locked_at = NULL,
            run_after = now() + ${`${30 * job.attempts} seconds`}::interval
          WHERE id = ${job.id}`;
      }
      await logEvent(tx, {
        festivalId: file.festival_id,
        kind: final ? "audio.failed" : "audio.retry",
        detail: `file ${file.id} attempt ${job.attempts}: ${message}`,
      });
    });
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/**
 * Poll the queue until `signal` aborts. `wake()` cuts the idle wait short (an
 * upload was just queued).
 */
export function startWorker(
  ctx: AppContext,
  signal: AbortSignal,
  idleMs = 2000,
): { wake: () => void; done: Promise<void> } {
  let wake = () => {};
  const done = (async () => {
    while (!signal.aborted) {
      let ran = false;
      try {
        ran = await runOne(ctx);
      } catch (err) {
        console.error("worker:", err);
      }
      if (ran) continue;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, idleMs);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
        signal.addEventListener("abort", () => wake(), { once: true });
      });
    }
  })();
  return { wake: () => wake(), done };
}
