import type { AudioKind } from "festival-bundle";
import { type AppContext } from "../context.ts";
import { sha256Hex } from "../crypto.ts";
import { logEvent } from "../db.ts";
import { UserError } from "../errors.ts";
import { sniffAudio } from "./sniff.ts";

export const AUDIO_KIND_LABEL: Record<AudioKind, string> = {
  music: "Music",
  announce: "Announcement",
};

export interface AudioFileRow {
  id: number;
  entry_id: number;
  kind: AudioKind;
  status: "processing" | "ready" | "failed";
  reason: string | null;
  original_key: string;
  original_sha256: string;
  original_bytes: number;
  original_name: string;
  original_format: "mp3" | "wav";
  storage_key: string | null;
  sha256: string | null;
  bytes: number | null;
  content_type: string | null;
  target_lufs: number | null;
  lufs: number | null;
  true_peak_db: number | null;
  flag: string | null;
  uploaded_at: Date;
  processed_at: Date | null;
}

/**
 * Accept an upload for one entry and kind: sniff it, keep the original under a
 * content-addressed key, replace any earlier file of that kind and queue the
 * normalisation. Permission and deadline checks are the caller's.
 */
export async function acceptUpload(
  ctx: AppContext,
  u: {
    entryId: number;
    kind: AudioKind;
    data: Uint8Array;
    name: string;
    userId: number;
    festivalId: number;
  },
): Promise<number> {
  if (u.data.length === 0) throw new UserError("The file is empty.");
  if (u.data.length > ctx.config.maxUploadBytes) {
    throw new UserError(
      `The file is larger than ${ctx.config.maxUploadBytes / 1024 / 1024} MB.`,
      413,
    );
  }
  const format = sniffAudio(u.data.subarray(0, 12));
  if (!format) {
    throw new UserError("Only mp3 or wav files are accepted.", 422);
  }
  const sha = await sha256Hex(u.data);
  const key = `originals/${sha}.${format}`;
  if (!(await ctx.storage.exists(key))) await ctx.storage.put(key, u.data);

  const id = await ctx.sql.begin(async (tx) => {
    await tx`DELETE FROM audio_files WHERE entry_id = ${u.entryId} AND kind = ${u.kind}`;
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO audio_files (entry_id, kind, original_key, original_sha256,
        original_bytes, original_name, original_format, uploaded_by)
      VALUES (${u.entryId}, ${u.kind}, ${key}, ${sha}, ${u.data.length},
        ${u.name.slice(0, 200)}, ${format}, ${u.userId})
      RETURNING id`;
    await tx`INSERT INTO audio_jobs (audio_file_id) VALUES (${row.id})`;
    await logEvent(tx, {
      festivalId: u.festivalId,
      userId: u.userId,
      kind: "audio.upload",
      detail:
        `entry ${u.entryId} ${u.kind}: ${u.name} (${u.data.length} bytes, ${format})`,
    });
    return row.id;
  });
  ctx.wakeWorker?.();
  return id;
}

/** Mark a file failed by hand (admin rejected it). */
export async function rejectAudio(
  ctx: AppContext,
  fileId: number,
  reason: string,
  userId: number,
): Promise<void> {
  const [row] = await ctx.sql<{ festival_id: number }[]>`
    UPDATE audio_files a SET status = 'failed', reason = ${
    "rejected: " + reason
  }
    FROM entries e JOIN competitions c ON c.id = e.competition_id
    WHERE a.id = ${fileId} AND e.id = a.entry_id
    RETURNING c.festival_id`;
  if (!row) throw new UserError("No such file.", 404);
  await logEvent(ctx.sql, {
    festivalId: row.festival_id,
    userId,
    kind: "audio.reject",
    detail: `file ${fileId}: ${reason}`,
  });
}
