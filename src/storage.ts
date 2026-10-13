import { dirname, join } from "node:path";

/**
 * Where originals and normalised audio live. Keys are relative paths such as
 * `originals/<sha256>.wav`. Behind an interface so a bucket can replace the
 * local disk (portal.md section 7).
 */
export interface Storage {
  /** Store bytes under `key` (atomic: readers never see a partial file). */
  put(key: string, data: Uint8Array): Promise<void>;
  /** Move a local file in under `key`. */
  putFile(key: string, path: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  size(key: string): Promise<number>;
  /** A readable stream of bytes `[start, end]` (inclusive), or all of it. */
  read(
    key: string,
    range?: { start: number; end: number },
  ): Promise<ReadableStream<Uint8Array>>;
  /**
   * Run `fn` with a local path to the file (ffmpeg needs one). A bucket
   * implementation would download to a temporary file first.
   */
  withLocalPath<T>(key: string, fn: (path: string) => Promise<T>): Promise<T>;
  delete(key: string): Promise<void>;
}

export class DiskStorage implements Storage {
  constructor(private root: string) {}

  private path(key: string): string {
    if (
      key.startsWith("/") || key.split("/").some((p) => p === ".." || p === "")
    ) {
      throw new Error(`bad storage key: ${key}`);
    }
    return join(this.root, key);
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const path = this.path(key);
    await Deno.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    await Deno.writeFile(tmp, data);
    await Deno.rename(tmp, path);
  }

  async putFile(key: string, src: string): Promise<void> {
    const path = this.path(key);
    await Deno.mkdir(dirname(path), { recursive: true });
    try {
      await Deno.rename(src, path);
    } catch {
      // Across file systems: copy, then rename into place.
      const tmp = `${path}.${crypto.randomUUID()}.tmp`;
      await Deno.copyFile(src, tmp);
      await Deno.rename(tmp, path);
      await Deno.remove(src).catch(() => {});
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await Deno.stat(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  async size(key: string): Promise<number> {
    return (await Deno.stat(this.path(key))).size;
  }

  read(
    key: string,
    range?: { start: number; end: number },
  ): Promise<ReadableStream<Uint8Array>> {
    return openFile(this.path(key), range);
  }

  withLocalPath<T>(key: string, fn: (path: string) => Promise<T>): Promise<T> {
    return fn(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await Deno.remove(this.path(key)).catch(() => {});
  }
}

/** A readable stream of a local file, or of bytes `[start, end]` (inclusive). */
export async function openFile(
  path: string,
  range?: { start: number; end: number },
): Promise<ReadableStream<Uint8Array>> {
  const file = await Deno.open(path);
  if (!range) return file.readable;
  await file.seek(range.start, Deno.SeekMode.Start);
  let left = range.end - range.start + 1;
  const reader = file.readable.getReader();
  return new ReadableStream({
    async pull(ctl) {
      const { done, value } = await reader.read();
      if (done) return ctl.close();
      const chunk = value.length > left ? value.subarray(0, left) : value;
      left -= chunk.length;
      ctl.enqueue(chunk);
      if (left <= 0) {
        ctl.close();
        await reader.cancel().catch(() => {});
      }
    },
    cancel: () => reader.cancel(),
  });
}
