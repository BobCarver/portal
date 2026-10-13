/**
 * Recognise an upload by its first bytes, never by its name or content type
 * (portal.md section 6). WAV: `RIFF....WAVE`. MP3: an `ID3` tag, or an MPEG
 * frame sync (0xFF then a byte with the top three bits set).
 */
export type AudioFormat = "mp3" | "wav";

/** How many leading bytes `sniffAudio` needs. */
export const SNIFF_BYTES = 12;

export function sniffAudio(head: Uint8Array): AudioFormat | null {
  if (
    head.length >= 12 &&
    ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WAVE"
  ) {
    return "wav";
  }
  if (head.length >= 3 && ascii(head, 0, 3) === "ID3") return "mp3";
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    return "mp3";
  }
  return null;
}

function ascii(b: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...b.subarray(from, to));
}
