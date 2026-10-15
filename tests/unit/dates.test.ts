import { assertEquals, assertThrows } from "@std/assert";
import { parseIsoDate } from "../../src/http.ts";
import { parseBirthDate } from "../../src/profile.ts";

Deno.test("iso date: a real calendar date, or a readable refusal", () => {
  assertEquals(parseIsoDate("2026-10-20"), "2026-10-20");
  assertEquals(parseIsoDate(" 2024-02-29 "), "2024-02-29", "leap day, trimmed");
  assertThrows(() => parseIsoDate("2026-02-31"), Error, "not a real date");
  assertThrows(() => parseIsoDate("2025-02-29"), Error, "not a real date");
  assertThrows(() => parseIsoDate("20/10/2026"), Error, "YYYY-MM-DD");
  assertThrows(() => parseIsoDate("", "age date"), Error, "age date");
});

Deno.test("birth date: in the past, after 1900", () => {
  const today = new Date("2026-10-20T12:00:00Z");
  assertEquals(parseBirthDate("1990-05-01", today), "1990-05-01");
  assertEquals(parseBirthDate("2026-10-20", today), "2026-10-20", "born today");
  assertThrows(() => parseBirthDate("2026-10-21", today), Error, "in the past");
  assertThrows(() => parseBirthDate("1899-12-31", today), Error, "after 1900");
  assertThrows(
    () => parseBirthDate("1990-13-01", today),
    Error,
    "not a real date",
  );
});
