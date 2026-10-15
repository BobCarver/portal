/**
 * Competitions created before the schedule exists: competitors can enter them,
 * but the export is refused until each one with entries has a track and session.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { FestivalData } from "festival-bundle";
import { join } from "node:path";
import { drain } from "../../src/audio/worker.ts";
import {
  Client,
  databaseAvailable,
  makeWav,
  redirected,
  testContext,
} from "../helpers.ts";

const ok = await databaseAvailable();

Deno.test({
  name: "unscheduled competitions: enter now, schedule before export",
  ignore: !ok,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { ctx, cleanup } = await testContext();
    try {
      const admin = new Client(ctx);
      await admin.post("/register", {
        name: "Org",
        email: "org@example.com",
        password: "a long enough password",
      });
      await ctx.sql`UPDATE users SET is_admin = true`;
      let r = await admin.post("/admin/festivals", { name: "Spring" });
      const fid = Number(redirected(r).path.split("/")[3]);
      await admin.post("/admin/rubrics", {
        festival_id: String(fid),
        name: "R",
      });
      const [rubric] = await ctx.sql`SELECT id FROM rubrics`;
      await admin.post("/admin/criteria", {
        rubric_id: String(rubric.id),
        name: "T",
      });
      await admin.post("/admin/judges", {
        festival_id: String(fid),
        name: "Ada",
      });
      const [crit] = await ctx.sql`SELECT id FROM criteria`;
      const [judge] = await ctx.sql`SELECT id FROM judges`;
      await admin.post(`/admin/rubrics/${rubric.id}/judges`, {
        jc: `${judge.id}:${crit.id}`,
      });

      // No track or session exists yet.
      r = await admin.post("/admin/competitions", {
        festival_id: String(fid),
        name: "Hip hop solo",
        rubric_id: String(rubric.id),
        session_id: "",
      });
      assertStringIncludes(redirected(r).ok ?? "", "Schedule it in a session");
      const [comp] = await ctx
        .sql`SELECT id, session_id, order_number FROM competitions`;
      assertEquals([comp.session_id, comp.order_number], [null, null]);
      assertStringIncludes(
        await (await admin.get(`/admin/f/${fid}/structure`)).text(),
        "Not scheduled yet",
      );

      // Competitors can already enter it.
      await admin.post(`/admin/f/${fid}/settings`, {
        name: "Spring",
        registration_open: "1",
        tz_offset: "0",
      });
      const dancer = new Client(ctx);
      await dancer.post("/register", {
        name: "D",
        email: "d@example.com",
        password: "a long enough password",
      });
      await dancer.post("/profile", {
        gender: "female",
        date_of_birth: "1990-05-01",
        level: "amateur",
      });
      r = await dancer.post("/competitors", {
        name: "Dee",
        type: "individual",
      });
      const competitorId = Number(redirected(r).path.split("/").pop());
      assertStringIncludes(
        await (await dancer.get(`/festivals/${fid}/enter`)).text(),
        "Hip hop solo · Open · not scheduled yet",
      );
      r = await dancer.post("/entries", {
        competitor_id: String(competitorId),
        competition_id: String(comp.id),
        duration: "60",
      });
      const entryId = Number(redirected(r).path.split("/").pop());
      assertStringIncludes(
        await (await dancer.get(`/entries/${entryId}`)).text(),
        "not scheduled yet",
      );
      const f = new FormData();
      f.append(
        "file",
        new File([await makeWav(1) as Uint8Array<ArrayBuffer>], "m.wav"),
      );
      await dancer.post(`/entries/${entryId}/audio/music`, f);
      await drain(ctx);

      // The export is refused, with a readable reason, on the page and on submit.
      const exportPage = await (await admin.get(`/admin/f/${fid}/export`))
        .text();
      assertStringIncludes(exportPage, "The bundle cannot be exported");
      assertStringIncludes(exportPage, "has 1 entry but no track and session");
      r = await admin.post(`/admin/f/${fid}/export`, { kind: "dry" });
      assertStringIncludes(
        redirected(r).err ?? "",
        "schedule it before exporting",
      );
      r = await admin.post(`/admin/competitions/${comp.id}/move`, {
        dir: "up",
      });
      assertStringIncludes(redirected(r).err ?? "", "Schedule the competition");

      // Schedule it: it gets the next running order number in that session.
      await admin.post("/admin/tracks", {
        festival_id: String(fid),
        name: "Main",
        location: "",
      });
      const [track] = await ctx.sql`SELECT id FROM tracks`;
      await admin.post("/admin/sessions", {
        track_id: String(track.id),
        name: "Morning",
        start_time: "2027-04-01T09:00",
        tz_offset: "0",
      });
      const [session] = await ctx.sql`SELECT id FROM sessions`;
      await admin.post("/admin/competitions", {
        session_id: String(session.id),
        name: "Already there",
        rubric_id: String(rubric.id),
      });
      const save = (sessionId: string) =>
        admin.post(`/admin/competitions/${comp.id}`, {
          name: "Hip hop solo",
          rubric_id: String(rubric.id),
          session_id: sessionId,
          open: "1",
        });
      r = await save(String(session.id));
      assertEquals(redirected(r).ok, "Competition saved.");
      const order = async () =>
        (await ctx
          .sql`SELECT name, order_number FROM competitions ORDER BY name`)
          .map((k) => `${k.name}:${k.order_number}`);
      assertEquals(await order(), ["Already there:1", "Hip hop solo:2"]);

      // A session cannot go while it has competitions; unscheduling closes the gap.
      r = await admin.post(`/admin/sessions/${session.id}/delete`);
      assertStringIncludes(redirected(r).err ?? "", "unschedule them");
      await admin.post(`/admin/competitions/${comp.id}/move`, { dir: "up" });
      assertEquals(await order(), ["Already there:2", "Hip hop solo:1"]);
      await save("");
      assertEquals(await order(), ["Already there:1", "Hip hop solo:null"]);
      await save(String(session.id));

      r = await admin.post(`/admin/f/${fid}/export`, { kind: "dry" });
      assertStringIncludes(
        redirected(r).ok ?? "",
        "bundle exported",
        redirected(r).err ?? "",
      );
      const [x] = await ctx.sql`SELECT folder FROM exports`;
      const data: FestivalData = JSON.parse(
        await Deno.readTextFile(join(x.folder, "data.json")),
      );
      const comps = data.festival.tracks[0].sessions[0].competitions;
      assertEquals(comps.map((k) => [k.name, k.order_number]), [[
        "Hip hop solo",
        2,
      ]]);
      assert(comps[0].competitors[0].audio.music, "music exported");
    } finally {
      await cleanup();
    }
  },
});
