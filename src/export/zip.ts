/**
 * A zip writer that stores files without compression (portal.md section 5:
 * mp3 does not compress). Streams each file from disk; switches to zip64
 * records when offsets pass 4 GB, so a large festival still makes one zip.
 */

export interface ZipEntry {
  /** Path inside the zip, `/`-separated. */
  name: string;
  /** Either a file on disk... */
  path?: string;
  /** ...or bytes in memory. */
  data?: Uint8Array;
}

const U32 = 0xffffffff;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = (crc ^ U32) >>> 0;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ U32) >>> 0;
}

async function crcOfFile(path: string): Promise<{ crc: number; size: number }> {
  let crc = 0, size = 0;
  using f = await Deno.open(path);
  for await (const chunk of f.readable) {
    crc = crc32(chunk, crc);
    size += chunk.length;
  }
  return { crc, size };
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) |
      (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) |
      d.getUTCDate(),
  };
}

class Buf {
  private parts: number[] = [];
  u16(n: number) {
    this.parts.push(n & 0xff, (n >>> 8) & 0xff);
    return this;
  }
  u32(n: number) {
    this.u16(n & 0xffff).u16(Math.floor(n / 0x10000) & 0xffff);
    return this;
  }
  u64(n: number) {
    return this.u32(n % 0x100000000).u32(Math.floor(n / 0x100000000));
  }
  bytes(b: Uint8Array) {
    for (const x of b) this.parts.push(x);
    return this;
  }
  done(): Uint8Array {
    return new Uint8Array(this.parts);
  }
}

export async function writeStoredZip(
  outPath: string,
  entries: ZipEntry[],
  modified = new Date(),
): Promise<void> {
  const { time, date } = dosTime(modified);
  using out = await Deno.open(outPath, {
    write: true,
    create: true,
    truncate: true,
  });
  const write = async (b: Uint8Array) => {
    let off = 0;
    while (off < b.length) off += await out.write(b.subarray(off));
  };
  let offset = 0;
  const central: Uint8Array[] = [];

  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    const { crc, size } = e.data
      ? { crc: crc32(e.data), size: e.data.length }
      : await crcOfFile(e.path!);
    if (size >= U32) {
      throw new Error(`${e.name}: too large for this zip writer`);
    }

    const local = new Buf()
      .u32(0x04034b50).u16(20).u16(0x0800).u16(0) // version, utf-8 names, stored
      .u16(time).u16(date).u32(crc).u32(size).u32(size)
      .u16(name.length).u16(0).bytes(name).done();
    await write(local);
    if (e.data) {
      await write(e.data);
    } else {
      using f = await Deno.open(e.path!);
      for await (const chunk of f.readable) await write(chunk);
    }

    const big = offset >= U32;
    const c = new Buf()
      .u32(0x02014b50).u16(45).u16(big ? 45 : 20).u16(0x0800).u16(0)
      .u16(time).u16(date).u32(crc).u32(size).u32(size)
      .u16(name.length).u16(big ? 12 : 0).u16(0) // name, extra, comment
      .u16(0).u16(0).u32(0) // disk, internal and external attributes
      .u32(big ? U32 : offset).bytes(name);
    if (big) c.u16(0x0001).u16(8).u64(offset); // zip64: the local header offset
    central.push(c.done());
    offset += local.length + size;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    await write(c);
    cdSize += c.length;
  }
  const n = entries.length;
  if (n > 0xffff || cdStart >= U32 || cdSize >= U32) {
    const zip64End = cdStart + cdSize;
    await write(
      new Buf()
        .u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0)
        .u64(n).u64(n).u64(cdSize).u64(cdStart).done(),
    );
    await write(new Buf().u32(0x07064b50).u32(0).u64(zip64End).u32(1).done());
  }
  await write(
    new Buf()
      .u32(0x06054b50).u16(0).u16(0)
      .u16(Math.min(n, 0xffff)).u16(Math.min(n, 0xffff))
      .u32(Math.min(cdSize, U32)).u32(Math.min(cdStart, U32)).u16(0).done(),
  );
}
