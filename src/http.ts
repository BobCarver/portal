import { UserError } from "./errors.ts";
import { openFile } from "./storage.ts";

/** A single `bytes=` range, resolved against `size`; null = whole file; "bad" = 416. */
export function parseRange(
  header: string | null | undefined,
  size: number,
): { start: number; end: number } | null | "bad" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null; // multi-range etc.: send it all
  let start: number, end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "bad";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "bad";
  return { start, end };
}

/**
 * A file response with HTTP Range support (resumable downloads, audio
 * seeking).
 */
export async function rangeResponse(
  req: Request,
  size: number,
  open: (
    range?: { start: number; end: number },
  ) => Promise<ReadableStream<Uint8Array>>,
  headers: Record<string, string>,
): Promise<Response> {
  const base = { ...headers, "accept-ranges": "bytes" };
  const range = parseRange(req.headers.get("range"), size);
  if (range === "bad") {
    return new Response(null, {
      status: 416,
      headers: { ...base, "content-range": `bytes */${size}` },
    });
  }
  if (req.method === "HEAD") {
    return new Response(null, {
      headers: { ...base, "content-length": String(size) },
    });
  }
  if (!range) {
    return new Response(await open(), {
      headers: { ...base, "content-length": String(size) },
    });
  }
  return new Response(await open(range), {
    status: 206,
    headers: {
      ...base,
      "content-length": String(range.end - range.start + 1),
      "content-range": `bytes ${range.start}-${range.end}/${size}`,
    },
  });
}

/** A local file with Range support. */
export async function fileResponse(
  req: Request,
  path: string,
  headers: Record<string, string>,
): Promise<Response> {
  let size: number;
  try {
    size = (await Deno.stat(path)).size;
  } catch {
    throw new UserError("That file is no longer on the server.", 404);
  }
  return rangeResponse(req, size, (range) => openFile(path, range), headers);
}

/** Form helpers. */
export function str(form: Record<string, unknown>, name: string): string {
  const v = form[name];
  return typeof v === "string" ? v.trim() : "";
}

export function int(form: Record<string, unknown>, name: string): number {
  const n = Number(str(form, name));
  if (!Number.isInteger(n)) {
    throw new UserError(`${name} must be a whole number.`, 422);
  }
  return n;
}

export function required(
  form: Record<string, unknown>,
  name: string,
  label = name,
): string {
  const v = str(form, name);
  if (!v) throw new UserError(`Enter ${label}.`, 422);
  return v.slice(0, 200);
}

/** Seconds, from "95", "1:35" or "1m35s". */
export function parseDuration(text: string): number {
  const t = text.trim();
  let m = /^(\d+)$/.exec(t);
  if (m) return Number(m[1]);
  m = /^(\d+):([0-5]?\d)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/i.exec(t);
  if (m && (m[1] || m[2])) return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  throw new UserError(
    "Enter the duration as seconds (95) or minutes:seconds (1:35).",
    422,
  );
}

/**
 * A `datetime-local` value typed in the browser's time zone. `offsetMinutes`
 * is the browser's `getTimezoneOffset()` (0 without script: UTC).
 */
export function parseLocalDateTime(value: string, offsetMinutes: number): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    value.trim(),
  );
  if (!m) throw new UserError("Enter a date and time.", 422);
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  return new Date(
    utc + (Number.isFinite(offsetMinutes) ? offsetMinutes : 0) * 60_000,
  );
}
