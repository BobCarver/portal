import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import { sniffAudio } from "../../src/audio/sniff.ts";
import { hashPassword, verifyPassword } from "../../src/crypto.ts";
import { parseLocalDateTime, parseRange } from "../../src/http.ts";
import { moveBy, moveTo } from "../../src/order.ts";
import { html, raw } from "../../src/views/html.ts";

const bytes = (...xs: (number | string)[]) =>
  new Uint8Array(
    xs.flatMap((x) =>
      typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x]
    ),
  );

Deno.test("sniff: WAV needs RIFF....WAVE", () => {
  assertEquals(sniffAudio(bytes("RIFF", 1, 2, 3, 4, "WAVE")), "wav");
  assertEquals(sniffAudio(bytes("RIFF", 1, 2, 3, 4, "AVI ")), null);
});

Deno.test("sniff: MP3 by ID3 tag or MPEG frame sync", () => {
  assertEquals(sniffAudio(bytes("ID3", 4, 0)), "mp3");
  assertEquals(sniffAudio(bytes(0xff, 0xfb, 0x90)), "mp3");
  assertEquals(sniffAudio(bytes(0xff, 0xe0)), "mp3");
  assertEquals(
    sniffAudio(bytes(0xff, 0xd0)),
    null,
    "top three bits not all set",
  );
});

Deno.test("sniff: never by name or content: other files are refused", () => {
  assertEquals(sniffAudio(bytes("%PDF-1.7")), null);
  assertEquals(sniffAudio(bytes("fLaC", 0, 0, 0)), null);
  assertEquals(sniffAudio(new Uint8Array()), null);
  assertEquals(sniffAudio(bytes(0xff)), null);
});

Deno.test("running order: move to a position, up and down", () => {
  assertEquals(moveTo([1, 2, 3, 4], 4, 1), [4, 1, 2, 3]);
  assertEquals(moveTo([1, 2, 3, 4], 1, 99), [2, 3, 4, 1]);
  assertEquals(moveTo([1, 2, 3, 4], 2, 0), [2, 1, 3, 4]);
  assertEquals(moveBy([1, 2, 3], 2, -1), [2, 1, 3]);
  assertEquals(moveBy([1, 2, 3], 3, 1), [1, 2, 3]);
  assertEquals(moveBy([1, 2, 3], 9, 1), [1, 2, 3]);
});

Deno.test("passwords: only a salted hash is stored, and it verifies", async () => {
  const h = await hashPassword("correct horse battery", 1000);
  assert(h.startsWith("pbkdf2-sha256$1000$"));
  assertFalse(h.includes("correct horse"));
  assert(await verifyPassword("correct horse battery", h));
  assertFalse(await verifyPassword("wrong horse battery", h));
  assertFalse(await verifyPassword("x", "garbage"));
  assert(
    (await hashPassword("same", 1000)) !== (await hashPassword("same", 1000)),
  );
});

Deno.test("html: interpolations are escaped, nested templates are not", () => {
  const name = `<script>alert("x")</script>`;
  // deno-fmt-ignore
  const out = html`<p>${name}</p>${html`<b>${"&"}</b>`}${raw("<i>ok</i>")}${[html`<br>`, "<"]}`.value;
  assertEquals(
    out,
    `<p>&#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62;</p><b>&#38;</b><i>ok</i><br>&#60;`,
  );
});

Deno.test("range header", () => {
  assertEquals(parseRange(null, 100), null);
  assertEquals(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assertEquals(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assertEquals(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assertEquals(parseRange("bytes=50-500", 100), { start: 50, end: 99 });
  assertEquals(parseRange("bytes=100-", 100), "bad");
  assertEquals(parseRange("bytes=0-1,5-6", 100), null);
});

Deno.test("local date-time input with the browser's offset", () => {
  // Chicago in October: getTimezoneOffset() = 300 (UTC-5).
  assertEquals(
    parseLocalDateTime("2026-10-20T13:00", 300).toISOString(),
    "2026-10-20T18:00:00.000Z",
  );
  assertEquals(
    parseLocalDateTime("2026-10-20T18:00", 0).toISOString(),
    "2026-10-20T18:00:00.000Z",
  );
  assertThrows(() => parseLocalDateTime("tomorrow", 0));
});
