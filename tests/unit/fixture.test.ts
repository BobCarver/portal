/**
 * The fixture bundle (made by `deno task seed --fixture fixtures/bundles/demo`)
 * passes the same checks the competition server's loader runs, so both
 * projects can test against one bundle.
 */
import { assertEquals } from "@std/assert";
import {
  audioFileName,
  type BundleManifest,
  type FestivalData,
  sha256Hex,
  validateData,
  validateManifest,
} from "festival-bundle";

const dir = new URL("../../fixtures/bundles/demo/", import.meta.url);

Deno.test("fixture bundle: valid for the competition server's loader", async () => {
  const dataText = await Deno.readTextFile(new URL("data.json", dir));
  const data: FestivalData = JSON.parse(dataText);
  const manifest: BundleManifest = JSON.parse(
    await Deno.readTextFile(new URL("manifest.json", dir)),
  );
  assertEquals(validateData(data), []);
  assertEquals(await validateManifest(manifest, dataText, data), []);
  for (const a of manifest.audio) {
    const bytes = await Deno.readFile(
      new URL(`audio/${audioFileName(a)}`, dir),
    );
    assertEquals(bytes.length, a.bytes);
    assertEquals(await sha256Hex(bytes), a.sha256);
  }
});
