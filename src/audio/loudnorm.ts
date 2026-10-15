/**
 * Loudness normalisation with ffmpeg `loudnorm`, two passes (portal.md
 * section 6): measure, then apply the measured values in linear mode where
 * possible, with a true-peak limit. Output: one format for every file (mp3 at a
 * fixed bitrate and sample rate, metadata stripped).
 */

export interface LoudnormOptions {
  targetLufs: number;
  truePeakDb: number;
  /** Loudness range target; raised to the measured range so linear mode is kept. */
  lra: number;
  bitrate: string;
  sampleRate: number;
  ffmpeg?: string;
  timeoutMs?: number;
}

export interface LoudnormResult {
  /** Integrated loudness of the result; null when it could not be measured (silence). */
  lufs: number | null;
  truePeakDb: number | null;
  /** "linear" | "dynamic" | "none" (silent input: transcoded only). */
  mode: string;
  /** Something an admin should look at, or null. */
  flag: string | null;
}

/** The input is not usable audio: retrying will not help. */
export class AudioRejected extends Error {}

interface Measured {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
  output_i?: string;
  output_tp?: string;
  normalization_type?: string;
}

export async function normalise(
  input: string,
  output: string,
  opts: LoudnormOptions,
): Promise<LoudnormResult> {
  const base = `I=${opts.targetLufs}:TP=${opts.truePeakDb}`;
  const first = await ffmpeg(opts, [
    "-i",
    input,
    "-map",
    "0:a:0",
    "-af",
    `loudnorm=${base}:LRA=${opts.lra}:print_format=json`,
    "-f",
    "null",
    "-",
  ]);
  const m = parseLoudnormJson(first);
  const inputI = Number(m.input_i);

  const encode = [
    "-ar",
    String(opts.sampleRate),
    "-c:a",
    "libmp3lame",
    "-b:a",
    opts.bitrate,
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    "-flags:a",
    "+bitexact",
    "-y",
    output,
  ];

  if (!Number.isFinite(inputI)) {
    // Silence (or nearly): nothing to measure, so nothing to normalise.
    await ffmpeg(opts, ["-i", input, "-map", "0:a:0", ...encode]);
    return {
      lufs: null,
      truePeakDb: null,
      mode: "none",
      flag: "silent: loudness could not be measured",
    };
  }

  // Keep linear mode when the track's own range is wider than the target.
  const lra = Math.min(50, Math.max(opts.lra, Math.ceil(Number(m.input_lra))));
  const second = await ffmpeg(opts, [
    "-i",
    input,
    "-map",
    "0:a:0",
    "-af",
    `loudnorm=${base}:LRA=${lra}` +
    `:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
    `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}` +
    `:offset=${m.target_offset}:linear=true:print_format=json`,
    ...encode,
  ]);
  const r = parseLoudnormJson(second);
  const lufs = Number(r.output_i);
  const truePeakDb = Number(r.output_tp);
  const mode = r.normalization_type ?? "unknown";

  const flags: string[] = [];
  // How far the peaks would overshoot the limit at the target loudness: that
  // much has to be taken off by the limiter.
  const limiting = Number(m.input_tp) + (opts.targetLufs - inputI) -
    opts.truePeakDb;
  if (limiting > 1) {
    flags.push(
      `needed ${limiting.toFixed(1)} dB of limiting to reach the target`,
    );
  }
  if (Number.isFinite(lufs) && Math.abs(lufs - opts.targetLufs) > 1) {
    flags.push(`ended at ${lufs.toFixed(1)} LUFS (target ${opts.targetLufs})`);
  }
  if (Number.isFinite(truePeakDb) && truePeakDb > opts.truePeakDb + 0.5) {
    flags.push(`true peak ${truePeakDb.toFixed(1)} dBTP above the limit`);
  }
  return {
    lufs: Number.isFinite(lufs) ? round1(lufs) : null,
    truePeakDb: Number.isFinite(truePeakDb) ? round1(truePeakDb) : null,
    mode,
    flag: flags.length ? flags.join("; ") : null,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The last `{...}` block ffmpeg's loudnorm printed to stderr. */
export function parseLoudnormJson(stderr: string): Measured {
  const end = stderr.lastIndexOf("}");
  const start = stderr.lastIndexOf("{", end);
  if (start < 0 || end < 0) {
    throw new Error("ffmpeg loudnorm printed no measurement");
  }
  return JSON.parse(stderr.slice(start, end + 1));
}

async function ffmpeg(opts: LoudnormOptions, args: string[]): Promise<string> {
  const cmd = new Deno.Command(opts.ffmpeg ?? "ffmpeg", {
    args: ["-hide_banner", "-nostdin", "-nostats", ...args],
    stdin: "null",
    stdout: "null",
    stderr: "piped",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10 * 60_000),
  });
  const out = await cmd.output();
  const stderr = new TextDecoder().decode(out.stderr);
  if (!out.success) {
    const last = stderr.trim().split("\n").filter(Boolean).slice(-2).join(
      " / ",
    );
    throw new AudioRejected(
      `could not decode the audio: ${last || "ffmpeg failed"}`,
    );
  }
  return stderr;
}

/** The length of an audio file in seconds, from ffprobe. */
export async function lengthOf(
  path: string,
  ffprobe = "ffprobe",
): Promise<number> {
  const out = await new Deno.Command(ffprobe, {
    args: [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const seconds = Number(new TextDecoder().decode(out.stdout).trim());
  if (!out.success || !Number.isFinite(seconds)) {
    throw new Error(`ffprobe could not read the length of ${path}`);
  }
  return seconds;
}
