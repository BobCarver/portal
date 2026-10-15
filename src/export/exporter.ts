import {
  type AudioContentType,
  audioFileName,
  type AudioKind,
  type BundleAudioRef,
  type BundleCompetition,
  type BundleCompetitor,
  type BundleManifest,
  type BundleRubric,
  type BundleSession,
  type BundleTrack,
  canonicalData,
  canonicalJson,
  type CompetitorType,
  type FestivalData,
  makeManifest,
  type ManifestAudio,
  type ManifestProblem,
  referencedAudio,
  validateData,
  validateManifest,
} from "festival-bundle";
import { join } from "node:path";
import { type AppContext, nowOf } from "../context.ts";
import { logEvent } from "../db.ts";
import { UserError } from "../errors.ts";
import { festivalState, utcIso } from "../festival.ts";
import { writeStoredZip } from "./zip.ts";
import {
  type CompetitionRules,
  eligibility,
  type Member,
} from "../eligibility.ts";

/**
 * The exporter (portal.md section 7): one consistent snapshot, a nested tree
 * built from only the fields the bundle carries, readable validation, canonical
 * serialisation, the manifest, then the folder, the zip and an `exports` row.
 */

// --- 1. Snapshot --------------------------------------------------------------

/** Exactly the columns the exporter may use. Nothing private is read. */
export interface Snapshot {
  /** `age_on`: the date category ages are worked out on (ISO), or null. */
  festival: { id: number; name: string; age_on: string | null };
  tracks: { id: number; name: string; location: string }[];
  sessions: {
    id: number;
    track_id: number;
    name: string;
    start_time: Date;
    order_number: number;
  }[];
  /** Every competition of the festival, scheduled or not (session_id null). */
  competitions: (CompetitionRules & {
    id: number;
    session_id: number | null;
    name: string;
    /** Set exactly when session_id is. */
    order_number: number | null;
    rubric_id: number;
  })[];
  /**
   * The profiles of the members of every entered competitor: used only to check
   * that entries are still legal. Never copied into the bundle.
   */
  members: (Member & { competitor_id: number })[];
  rubrics: { id: number; name: string }[];
  criteria: { id: number; rubric_id: number; name: string; weight: number }[];
  judges: { id: number; name: string }[];
  judgeCriteria: { judge_id: number; criterion_id: number }[];
  entries: {
    id: number;
    competition_id: number;
    competitor_id: number;
    order_number: number;
    duration: number;
    competitor_name: string;
    competitor_type: CompetitorType;
  }[];
  audio: {
    entry_id: number;
    kind: AudioKind;
    status: "processing" | "ready" | "failed";
    reason: string | null;
    sha256: string | null;
    bytes: number | null;
    content_type: string | null;
    storage_key: string | null;
    lufs: number | null;
    true_peak_db: number | null;
  }[];
}

/** One REPEATABLE READ, read-only transaction: a few plain SELECTs per table. */
export function readSnapshot(
  ctx: AppContext,
  festivalId: number,
): Promise<Snapshot> {
  return ctx.sql.begin(
    "isolation level repeatable read read only",
    async (tx) => {
      const [festival] = await tx<Snapshot["festival"][]>`
      SELECT id, name, to_char(age_on, 'YYYY-MM-DD') AS age_on
      FROM festivals WHERE id = ${festivalId}`;
      if (!festival) throw new UserError("No such festival.", 404);
      return {
        festival,
        tracks: await tx`SELECT id, name, location FROM tracks
        WHERE festival_id = ${festivalId}`,
        sessions:
          await tx`SELECT s.id, s.track_id, s.name, s.start_time, s.order_number
        FROM sessions s JOIN tracks t ON t.id = s.track_id
        WHERE t.festival_id = ${festivalId}`,
        competitions: await tx`
        SELECT id, session_id, name, order_number, rubric_id,
          gender, level, min_age, max_age
        FROM competitions WHERE festival_id = ${festivalId}`,
        members: await tx`
        SELECT DISTINCT e.competitor_id, u.name, u.gender,
          u.date_of_birth::text AS date_of_birth, u.level
        FROM entries e
          JOIN competitions c ON c.id = e.competition_id
          JOIN competitor_members m ON m.competitor_id = e.competitor_id
          JOIN users u ON u.id = m.user_id
        WHERE c.festival_id = ${festivalId}`,
        rubrics:
          await tx`SELECT id, name FROM rubrics WHERE festival_id = ${festivalId}`,
        criteria: await tx`SELECT c.id, c.rubric_id, c.name, c.weight
        FROM criteria c JOIN rubrics r ON r.id = c.rubric_id
        WHERE r.festival_id = ${festivalId}`,
        judges:
          await tx`SELECT id, name FROM judges WHERE festival_id = ${festivalId}`,
        judgeCriteria: await tx`SELECT jc.judge_id, jc.criterion_id
        FROM judge_criteria jc JOIN judges j ON j.id = jc.judge_id
        WHERE j.festival_id = ${festivalId}`,
        entries: await tx`
        SELECT e.id, e.competition_id, e.competitor_id, e.order_number, e.duration,
          p.name AS competitor_name, p.type AS competitor_type
        FROM entries e JOIN competitors p ON p.id = e.competitor_id
          JOIN competitions c ON c.id = e.competition_id
        WHERE c.festival_id = ${festivalId}`,
        audio: await tx`
        SELECT a.entry_id, a.kind, a.status, a.reason, a.sha256, a.bytes,
          a.content_type, a.storage_key, a.lufs, a.true_peak_db
        FROM audio_files a JOIN entries e ON e.id = a.entry_id
          JOIN competitions c ON c.id = e.competition_id
        WHERE c.festival_id = ${festivalId}`,
      } as Snapshot;
    },
  );
}

// --- 2 and 3. Tree and validation ---------------------------------------------

export interface AudioSource {
  sha256: string;
  storage_key: string;
  lufs: number | null;
  true_peak_db: number | null;
}

/**
 * Every entry must still meet its competition's rules. Entries are checked
 * here as well as when they are made, so a bundle can never carry an illegal
 * entry. Messages name people but never show a date of birth.
 */
function eligibilityErrors(
  snap: Snapshot,
  entriesBy: Map<number, Snapshot["entries"]>,
): string[] {
  const errors: string[] = [];
  const membersOf = new Map<number, Snapshot["members"]>();
  for (const m of snap.members) {
    membersOf.set(m.competitor_id, [
      ...(membersOf.get(m.competitor_id) ?? []),
      m,
    ]);
  }
  const type = new Map(
    snap.entries.map((e) => [e.competitor_id, e.competitor_type]),
  );
  for (const c of snap.competitions) {
    for (const e of entriesBy.get(c.id) ?? []) {
      const problems = eligibility({
        type: type.get(e.competitor_id) ?? "individual",
        members: membersOf.get(e.competitor_id) ?? [],
        competition: c,
        ageOn: snap.festival.age_on,
      });
      if (problems.length) {
        errors.push(
          `${e.competitor_name} in ${c.name} is not eligible: ${
            problems.join("; ")
          }`,
        );
      }
    }
  }
  return errors;
}

export interface Built {
  data: FestivalData;
  /** Entries whose audio is not exported. Surfaced loudly, never dropped silently. */
  problems: ManifestProblem[];
  /** Validation failures: the export is refused. */
  errors: string[];
  /** Where each exported hash comes from. */
  sources: Map<string, AudioSource>;
}

const groupBy = <T, K>(xs: T[], key: (x: T) => K) => {
  const m = new Map<K, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
};

/**
 * Build data.json's tree from a snapshot. Copies only the fields of portal.md
 * section 4, which is what keeps private data out of the bundle. Competitions
 * with no entries are left out; each rubric they use is written once; only
 * judges assigned to an exported rubric are written.
 */
export function buildBundle(snap: Snapshot): Built {
  const problems: ManifestProblem[] = [];
  const sources = new Map<string, AudioSource>();
  const audioByEntry = groupBy(snap.audio, (a) => a.entry_id);
  const entriesBy = groupBy(snap.entries, (e) => e.competition_id);
  const competitionsBy = groupBy(snap.competitions, (c) => c.session_id);
  const sessionsBy = groupBy(snap.sessions, (s) => s.track_id);
  const usedRubrics = new Set<number>();

  const audioOf = (
    e: Snapshot["entries"][number],
  ): BundleCompetitor["audio"] => {
    const out: BundleCompetitor["audio"] = {};
    const files = new Map(
      (audioByEntry.get(e.id) ?? []).map((a) => [a.kind, a]),
    );
    for (const kind of ["music", "announce"] as const) {
      const a = files.get(kind);
      const problem = (reason: string) =>
        problems.push({
          competition_id: e.competition_id,
          competitor_id: e.competitor_id,
          kind,
          reason,
        });
      if (!a) {
        if (kind === "music") problem("missing");
        continue;
      }
      if (a.status !== "ready" || !a.sha256 || !a.bytes || !a.storage_key) {
        problem(
          a.status === "failed" ? `failed: ${a.reason ?? "unknown"}` : a.status,
        );
        continue;
      }
      const ref: BundleAudioRef = {
        sha256: a.sha256,
        content_type: a.content_type as AudioContentType,
        bytes: Number(a.bytes),
      };
      out[kind] = ref;
      sources.set(a.sha256, {
        sha256: a.sha256,
        storage_key: a.storage_key,
        lufs: a.lufs,
        true_peak_db: a.true_peak_db,
      });
    }
    return out;
  };

  const tracks: BundleTrack[] = snap.tracks.map((t) => ({
    id: t.id,
    name: t.name,
    location: t.location,
    sessions: (sessionsBy.get(t.id) ?? []).map((s): BundleSession => ({
      id: s.id,
      name: s.name,
      start_time: utcIso(s.start_time),
      order_number: s.order_number,
      competitions: (competitionsBy.get(s.id) ?? [])
        .filter((c) => (entriesBy.get(c.id) ?? []).length > 0)
        .map((c): BundleCompetition => {
          usedRubrics.add(c.rubric_id);
          return {
            id: c.id,
            name: c.name,
            order_number: c.order_number!,
            rubric_id: c.rubric_id,
            competitors: (entriesBy.get(c.id) ?? []).map((e) => ({
              id: e.competitor_id,
              name: e.competitor_name,
              type: e.competitor_type,
              order_number: e.order_number,
              duration: e.duration,
              audio: audioOf(e),
            })),
          };
        }),
    })),
  }));

  const criteriaBy = groupBy(snap.criteria, (c) => c.rubric_id);
  const criterionRubric = new Map(
    snap.criteria.map((c) => [c.id, c.rubric_id]),
  );
  const judgeName = new Map(snap.judges.map((j) => [j.id, j.name]));
  const rubrics: BundleRubric[] = snap.rubrics
    .filter((r) => usedRubrics.has(r.id))
    .map((r) => {
      const judges = new Map<number, number[]>();
      for (const jc of snap.judgeCriteria) {
        if (criterionRubric.get(jc.criterion_id) !== r.id) continue;
        judges.set(jc.judge_id, [
          ...(judges.get(jc.judge_id) ?? []),
          jc.criterion_id,
        ]);
      }
      return {
        id: r.id,
        name: r.name,
        criteria: (criteriaBy.get(r.id) ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          weight: Number(c.weight),
        })),
        judges: [...judges].map(([id, criteria]) => ({
          id,
          name: judgeName.get(id) ?? "",
          criteria,
        })),
      };
    });

  const data: FestivalData = {
    festival: {
      id: snap.festival.id,
      name: snap.festival.name,
      rubrics,
      tracks,
    },
  };
  const errors = validateData(data);
  errors.push(...eligibilityErrors(snap, entriesBy));
  for (const c of snap.competitions) {
    const entries = (entriesBy.get(c.id) ?? []).length;
    if (entries > 0 && c.session_id === null) {
      errors.push(
        `competition ${c.id} (${c.name}) has ${entries} entr${
          entries === 1 ? "y" : "ies"
        } ` +
          "but no track and session: schedule it before exporting",
      );
    }
    if (entries > 0 && !snap.rubrics.some((r) => r.id === c.rubric_id)) {
      errors.push(
        `competition ${c.id} (${c.name}) uses a rubric of another festival`,
      );
    }
  }
  problems.sort((a, b) =>
    a.competition_id - b.competition_id || a.competitor_id - b.competitor_id ||
    a.kind.localeCompare(b.kind)
  );
  return { data, problems, errors, sources };
}

// --- 4 to 7. Serialise, manifest, write, record --------------------------------

export interface Prepared extends Built {
  dataText: string;
  manifest: BundleManifest;
  manifestText: string;
}

/** Steps 1 to 5 with no side effects: what the export page previews. */
export async function prepareExport(
  ctx: AppContext,
  festivalId: number,
  generatedAt = utcIso(
    new Date(Math.floor(nowOf(ctx).getTime() / 1000) * 1000),
  ),
): Promise<Prepared> {
  const built = buildBundle(await readSnapshot(ctx, festivalId));
  const dataText = canonicalData(built.data);
  const audio: ManifestAudio[] = referencedAudio(built.data).map((a) => {
    const src = built.sources.get(a.sha256);
    return {
      ...a,
      lufs: src?.lufs ?? undefined,
      true_peak_db: src?.true_peak_db ?? undefined,
    };
  });
  const manifest = await makeManifest({
    dataText,
    generatedAt,
    audio,
    problems: built.problems,
    loudnessTargetLufs: ctx.config.audio.musicLufs,
  });
  if (built.errors.length === 0) {
    built.errors.push(
      ...await validateManifest(manifest, dataText, built.data),
    );
  }
  return {
    ...built,
    dataText,
    manifest,
    manifestText: canonicalJson(manifest),
  };
}

export interface ExportResult {
  id: number;
  digest: string;
  folder: string;
  zip: string;
  problems: ManifestProblem[];
}

export const folderName = (festivalId: number, generatedAt: string) =>
  `festival-${festivalId}-${generatedAt.replaceAll(":", "-")}`;

export async function exportFestival(
  ctx: AppContext,
  festivalId: number,
  opts: { final: boolean; userId?: number; acceptProblems?: boolean },
): Promise<ExportResult> {
  const state = await festivalState(ctx.sql, festivalId, nowOf(ctx));
  if (state.final) {
    throw new UserError("The final bundle has already been exported.", 409);
  }
  let p = await prepareExport(ctx, festivalId);
  // Folders are named by the second: a second export within it waits for the next.
  for (
    let tries = 0;
    await exists(
      join(
        ctx.config.exportDir,
        folderName(festivalId, p.manifest.generated_at),
      ),
    );
    tries++
  ) {
    if (tries >= 3) {
      throw new UserError("Another export is being written; try again.", 409);
    }
    await new Promise((r) => setTimeout(r, 1000 - (Date.now() % 1000) + 5));
    p = await prepareExport(ctx, festivalId);
  }
  const kind = opts.final ? "final" : "dry run";
  if (p.errors.length > 0) {
    await logEvent(ctx.sql, {
      festivalId,
      userId: opts.userId,
      kind: "export.refused",
      detail: `${kind}: ${p.errors.length} error(s): ${
        p.errors.slice(0, 5).join("; ")
      }`,
    });
    throw new ExportRefused(p.errors);
  }
  if (opts.final && p.problems.length > 0 && !opts.acceptProblems) {
    throw new UserError(
      `${p.problems.length} entr${
        p.problems.length === 1 ? "y has" : "ies have"
      } ` +
        "audio that will not be exported. Resolve them, or confirm the final export anyway.",
      409,
    );
  }

  const name = folderName(festivalId, p.manifest.generated_at);
  const folder = join(ctx.config.exportDir, name);
  await writeFolder(ctx, folder, p);
  const zip = `${folder}.zip`;
  await writeStoredZip(
    zip,
    bundleFiles(name, folder, p).map((f) => ({
      name: f.zipName,
      path: f.path,
    })),
    new Date(p.manifest.generated_at),
  );

  const [row] = await ctx.sql.begin(async (tx) => {
    const rows = await tx<{ id: number }[]>`
      INSERT INTO exports (festival_id, final, generated_at, digest, data_sha256,
        data_text, manifest_text, problem_count, folder, created_by)
      VALUES (${festivalId}, ${opts.final}, ${p.manifest.generated_at},
        ${p.manifest.digest}, ${p.manifest.data_sha256}, ${p.dataText},
        ${p.manifestText}, ${p.problems.length}, ${folder}, ${
      opts.userId ?? null
    })
      RETURNING id`;
    await logEvent(tx, {
      festivalId,
      userId: opts.userId,
      kind: "export",
      detail: `${kind} export ${rows[0].id}: digest ${p.manifest.digest}, ` +
        `${p.manifest.audio.length} audio file(s), ${p.problems.length} problem(s)`,
    });
    return rows;
  }).catch(async (err) => {
    await Deno.remove(folder, { recursive: true }).catch(() => {});
    await Deno.remove(zip).catch(() => {});
    if (String(err?.message).includes("exports_one_final")) {
      throw new UserError("The final bundle has already been exported.", 409);
    }
    throw err;
  });
  return {
    id: row.id,
    digest: p.manifest.digest,
    folder,
    zip,
    problems: p.problems,
  };
}

export class ExportRefused extends UserError {
  constructor(readonly errors: string[]) {
    super(
      `The export was refused: ${errors.length} problem(s) in the structure.`,
      422,
    );
  }
}

/** The bundle's files in a fixed order: manifest, data, then audio by hash. */
function bundleFiles(name: string, folder: string, p: Prepared) {
  return [
    { zipName: `${name}/manifest.json`, path: join(folder, "manifest.json") },
    { zipName: `${name}/data.json`, path: join(folder, "data.json") },
    ...p.manifest.audio.map((a) => ({
      zipName: `${name}/audio/${audioFileName(a)}`,
      path: join(folder, "audio", audioFileName(a)),
    })),
  ];
}

/** Write into `<folder>.partial`, then rename: a folder that exists is complete. */
async function writeFolder(
  ctx: AppContext,
  folder: string,
  p: Prepared,
): Promise<void> {
  const tmp = `${folder}.partial`;
  await Deno.remove(tmp, { recursive: true }).catch(() => {});
  await Deno.mkdir(join(tmp, "audio"), { recursive: true });
  for (const a of p.manifest.audio) {
    const src = p.sources.get(a.sha256)!;
    const size = await ctx.storage.size(src.storage_key);
    if (size !== a.bytes) {
      throw new Error(
        `stored audio ${a.sha256} has ${size} bytes, expected ${a.bytes}`,
      );
    }
    const stream = await ctx.storage.read(src.storage_key);
    await Deno.writeFile(join(tmp, "audio", audioFileName(a)), stream);
  }
  await Deno.writeTextFile(join(tmp, "data.json"), p.dataText);
  await Deno.writeTextFile(join(tmp, "manifest.json"), p.manifestText);
  await Deno.rename(tmp, folder);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
