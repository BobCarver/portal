/**
 * Everything configurable, from the environment. One place, read once.
 */
export interface Config {
  port: number;
  /** Public base URL, used in emailed links and to decide secure cookies. */
  baseUrl: string;
  databaseUrl: string;
  /** Local storage root for originals and normalised audio. */
  storageDir: string;
  /** Where export bundles are written. */
  exportDir: string;
  maxUploadBytes: number;
  audio: {
    musicLufs: number;
    announceLufs: number;
    truePeakDb: number;
    /** loudnorm loudness range target. */
    lra: number;
    bitrate: string;
    sampleRate: number;
  };
  /** Run the normalisation worker inside the web process. */
  inlineWorker: boolean;
  /** Behind a reverse proxy: take the client address from X-Forwarded-For. */
  trustProxy: boolean;
  /** Score pushes larger than this are refused. */
  maxScoreBodyBytes: number;
}

export function loadConfig(
  get: (name: string) => string | undefined = (n) => Deno.env.get(n),
): Config {
  const num = (name: string, def: number) => {
    const raw = get(name);
    if (raw === undefined || raw === "") return def;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
    return n;
  };
  const port = num("PORT", 8080);
  return {
    port,
    baseUrl: (get("BASE_URL") ?? `http://localhost:${port}`).replace(/\/$/, ""),
    databaseUrl: get("DATABASE_URL") ??
      "postgres://postgres@localhost:5544/portal",
    storageDir: get("STORAGE_DIR") ?? "data/storage",
    exportDir: get("EXPORT_DIR") ?? "data/exports",
    maxUploadBytes: num("MAX_UPLOAD_MB", 50) * 1024 * 1024,
    audio: {
      musicLufs: num("MUSIC_TARGET_LUFS", -15),
      announceLufs: num("ANNOUNCE_TARGET_LUFS", -20),
      truePeakDb: num("TRUE_PEAK_DB", -1),
      lra: num("LOUDNESS_RANGE", 11),
      bitrate: get("AUDIO_BITRATE") ?? "192k",
      sampleRate: num("AUDIO_SAMPLE_RATE", 44100),
    },
    inlineWorker: (get("WORKER") ?? "inline") === "inline",
    trustProxy: get("TRUST_PROXY") === "1",
    maxScoreBodyBytes: num("MAX_SCORE_BODY_MB", 10) * 1024 * 1024,
  };
}
