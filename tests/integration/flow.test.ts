/**
 * The whole path through the portal, in process, with a real database and
 * real ffmpeg: organiser set-up, registration, upload -> normalise -> export,
 * the bundle checked with the competition server's own validator, the freeze,
 * the score receiver and the HTTPS bundle download.
 */
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  audioFileName,
  type BundleManifest,
  type FestivalData,
  sha256Hex,
  validateData,
  validateManifest,
} from "festival-bundle";
import { join } from "node:path";
import { drain } from "../../src/audio/worker.ts";
import { exportFestival } from "../../src/export/exporter.ts";
import {
  Client,
  databaseAvailable,
  makeWav,
  redirected,
  testContext,
} from "../helpers.ts";

const ok = await databaseAvailable();

async function signUp(
  client: Client,
  email: string,
  name = email.split("@")[0],
  level: "amateur" | "professional" = "amateur",
) {
  const res = await client.post("/register", {
    name,
    email,
    password: "a long enough password",
  });
  assertEquals(res.status, 303, await res.text());
  assert(client.cookies.size > 0, "signed in");
  // Every person needs a profile before they can enter (portal.md, categories).
  const profile = await client.post("/profile", {
    gender: "female",
    date_of_birth: "1990-05-01",
    level,
  });
  assertEquals(redirected(profile).ok, "Profile saved.");
}

const idFrom = (path: string) => Number(path.split("/").pop());

Deno.test({
  name: "portal: register, upload, normalise, export, freeze, scores",
  ignore: !ok,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const { ctx, cleanup } = await testContext({ MAX_UPLOAD_MB: "1" });
    try {
      // --- organiser sets up the festival ------------------------------------------
      const admin = new Client(ctx);
      await signUp(admin, "org@example.com", "Organiser");
      await ctx
        .sql`UPDATE users SET is_admin = true WHERE email = 'org@example.com'`;

      let r = await admin.post("/admin/festivals", { name: "Autumn Open" });
      const fid = Number(redirected(r).path.split("/")[3]);
      await admin.post("/admin/tracks", {
        festival_id: String(fid),
        name: "Main floor",
        location: "Hall A",
      });
      const [track] = await ctx.sql`SELECT id FROM tracks`;
      // 13:00 in a UTC-5 browser = 18:00 UTC.
      await admin.post("/admin/sessions", {
        track_id: String(track.id),
        name: "Evening",
        start_time: "2026-10-20T13:00",
        tz_offset: "300",
      });
      await admin.post("/admin/sessions", {
        track_id: String(track.id),
        name: "Afternoon",
        start_time: "2026-10-20T10:00",
        tz_offset: "300",
      });
      const sessions = await ctx
        .sql`SELECT id, name, order_number, start_time FROM sessions ORDER BY order_number`;
      assertEquals(
        sessions.map((s) => s.name),
        ["Afternoon", "Evening"],
        "sessions follow planned start",
      );
      assertEquals(
        sessions[1].start_time.toISOString(),
        "2026-10-20T18:00:00.000Z",
      );

      await admin.post("/admin/rubrics", {
        festival_id: String(fid),
        name: "Standard",
      });
      const [rubric] = await ctx.sql`SELECT id FROM rubrics`;
      await admin.post("/admin/criteria", {
        rubric_id: String(rubric.id),
        name: "Technique",
        weight: "1",
      });
      await admin.post("/admin/criteria", {
        rubric_id: String(rubric.id),
        name: "Musicality",
        weight: "2",
      });
      await admin.post("/admin/judges", {
        festival_id: String(fid),
        name: "Judge Ada",
        email: "ada@private.example",
      });
      await admin.post("/admin/judges", {
        festival_id: String(fid),
        name: "Judge Unused",
      });
      const crit = await ctx.sql`SELECT id FROM criteria ORDER BY id`;
      const [ada] = await ctx
        .sql`SELECT id FROM judges WHERE name = 'Judge Ada'`;
      const jc = new FormData();
      for (const k of crit) jc.append("jc", `${ada.id}:${k.id}`);
      r = await admin.post(`/admin/rubrics/${rubric.id}/judges`, jc);
      assertEquals(redirected(r).ok, "Assignments saved.");

      for (const name of ["Solo", "Couples", "Nobody"]) {
        await admin.post("/admin/competitions", {
          session_id: String(sessions[1].id),
          name,
          rubric_id: String(rubric.id),
        });
      }
      const comps = await ctx.sql<
        { id: number; name: string; order_number: number }[]
      >`
        SELECT id, name, order_number FROM competitions ORDER BY order_number`;
      assertEquals(comps.map((c) => c.order_number), [1, 2, 3]);
      r = await admin.post(`/admin/competitions/${comps[1].id}/move`, {
        dir: "up",
      });
      assertEquals(r.status, 303);
      const [solo, couples] = [comps[0], comps[1]];
      assertEquals(
        (await ctx.sql`SELECT name FROM competitions ORDER BY order_number`)
          .map((c) => c.name),
        ["Couples", "Solo", "Nobody"],
      );

      // Registration is closed until opened.
      const alex = new Client(ctx);
      await signUp(alex, "alex@example.com", "Alex");
      r = await alex.post("/competitors", {
        name: "Alex Rivera",
        type: "individual",
      });
      const alexId = idFrom(redirected(r).path);
      r = await alex.post("/entries", {
        competitor_id: String(alexId),
        competition_id: String(solo.id),
        duration: "1:35",
      });
      assertStringIncludes(redirected(r).err ?? "", "not open");

      r = await admin.post(`/admin/f/${fid}/settings`, {
        name: "Autumn Open",
        registration_open: "1",
        freeze_at: "",
        tz_offset: "0",
      });
      assertEquals(redirected(r).ok, "Settings saved.");

      // --- competitors register and upload --------------------------------------------
      await t.step("entering", async () => {
        r = await alex.post("/entries", {
          competitor_id: String(alexId),
          competition_id: String(solo.id),
          duration: "1:35",
        });
        assertEquals(redirected(r).ok, "Entered. Now upload your music.");
        r = await alex.post("/entries", {
          competitor_id: String(alexId),
          competition_id: String(solo.id),
          duration: "95",
        });
        assertStringIncludes(redirected(r).err ?? "", "already entered");
        // Someone else cannot use Alex's competitor.
        const mallory = new Client(ctx);
        await signUp(mallory, "mallory@example.com");
        r = await mallory.post("/entries", {
          competitor_id: String(alexId),
          competition_id: String(couples.id),
          duration: "60",
        });
        assertStringIncludes(redirected(r).err ?? "", "not a member");
        assertEquals((await mallory.get(`/competitors/${alexId}`)).status, 403);
      });

      const sam = new Client(ctx);
      await signUp(sam, "sam@example.com", "Sam", "professional");
      await signUp(new Client(ctx), "kim@example.com", "Kim");
      r = await sam.post("/competitors", {
        name: "Sam and Kim",
        type: "couple",
      });
      const samKimId = idFrom(redirected(r).path);
      await sam.post(`/competitors/${samKimId}/members`, {
        email: "kim@example.com",
      });
      assertEquals(
        (await ctx
          .sql`SELECT count(*)::int AS n FROM competitor_members WHERE competitor_id = ${samKimId}`)[
            0
          ].n,
        2,
      );
      await sam.post("/entries", {
        competitor_id: String(samKimId),
        competition_id: String(couples.id),
        duration: "120",
      });
      await alex.post("/entries", {
        competitor_id: String(alexId),
        competition_id: String(couples.id),
        duration: "90",
      });

      const entries = await ctx.sql<
        {
          id: number;
          competitor_id: number;
          competition_id: number;
          order_number: number;
        }[]
      >`
        SELECT id, competitor_id, competition_id, order_number FROM entries ORDER BY id`;
      const [alexSolo, samCouples, alexCouples] = entries;
      assertEquals(
        [samCouples.order_number, alexCouples.order_number],
        [1, 2],
        "entries by registration time",
      );

      const tone = await makeWav(2, "tone");
      const upload = (
        client: Client,
        entryId: number,
        kind: string,
        bytes: Uint8Array,
        name: string,
      ) => {
        const f = new FormData();
        f.append("file", new File([bytes as Uint8Array<ArrayBuffer>], name));
        return client.post(`/entries/${entryId}/audio/${kind}`, f);
      };

      await t.step(
        "upload rules: sniffing, size limit, ownership",
        async () => {
          r = await upload(
            alex,
            alexSolo.id,
            "music",
            new TextEncoder().encode("%PDF-1.7 not audio"),
            "song.mp3",
          );
          assertStringIncludes(redirected(r).err ?? "", "Only mp3 or wav");
          r = await upload(
            alex,
            alexSolo.id,
            "music",
            new Uint8Array(1_200_000),
            "big.wav",
          );
          assertStringIncludes(redirected(r).err ?? "", "larger than 1 MB");
          r = await upload(sam, alexSolo.id, "music", tone, "x.wav");
          assertStringIncludes(redirected(r).err ?? "", "not a member");
          assertEquals(
            (await ctx.sql`SELECT count(*)::int AS n FROM audio_files`)[0].n,
            0,
          );
        },
      );

      await t.step(
        "upload, normalise with real ffmpeg, play back",
        async () => {
          r = await upload(alex, alexSolo.id, "music", tone, "alex.wav");
          assertStringIncludes(redirected(r).ok ?? "", "normalising");
          // The same song again in another competition: stored once in the bundle.
          await upload(alex, alexCouples.id, "music", tone, "alex.wav");
          await upload(
            sam,
            samCouples.id,
            "music",
            await makeWav(1, "silence"),
            "silent.wav",
          );
          await upload(
            sam,
            samCouples.id,
            "announce",
            await makeWav(1, "tone"),
            "intro.wav",
          );
          const before = await ctx.sql`SELECT status FROM audio_files`;
          assert(before.every((f) => f.status === "processing"));
          assertEquals(await drain(ctx), 4);
          const files = await ctx
            .sql`SELECT entry_id, kind, status, reason, lufs, flag, sha256, target_lufs
          FROM audio_files ORDER BY id`;
          assertEquals(files.map((f) => f.status), [
            "ready",
            "ready",
            "ready",
            "ready",
          ], JSON.stringify(files));
          assertEquals(
            files[0].sha256,
            files[1].sha256,
            "same input, same normalised file",
          );
          assert(
            Math.abs(files[0].lufs + 15) <= 1,
            `music near -15 LUFS: ${files[0].lufs}`,
          );
          assertEquals(files[2].flag, "silent: loudness could not be measured");
          assertEquals(
            files[3].target_lufs,
            -20,
            "announcements have their own target",
          );

          const page = await (await alex.get(`/entries/${alexSolo.id}`)).text();
          assertStringIncludes(page, "ready");
          const [file] = await ctx
            .sql`SELECT id, bytes FROM audio_files WHERE entry_id = ${alexSolo.id}`;
          const play = await alex.request("GET", `/audio/${file.id}/play`, {
            headers: { range: "bytes=0-99" },
          });
          assertEquals(play.status, 206);
          assertEquals((await play.arrayBuffer()).byteLength, 100);
          assertEquals(
            play.headers.get("content-range"),
            `bytes 0-99/${file.bytes}`,
          );
          assertEquals((await sam.get(`/audio/${file.id}/play`)).status, 403);
        },
      );

      // --- export -------------------------------------------------------------------
      let first: Awaited<ReturnType<typeof exportFestival>>;
      await t.step(
        "dry-run export: valid for the competition server, reproducible, private",
        async () => {
          const [user] = await ctx
            .sql`SELECT id FROM users WHERE email = 'org@example.com'`;
          first = await exportFestival(ctx, fid, {
            final: false,
            userId: user.id,
          });
          const dataText = await Deno.readTextFile(
            join(first.folder, "data.json"),
          );
          const manifest: BundleManifest = JSON.parse(
            await Deno.readTextFile(join(first.folder, "manifest.json")),
          );
          const data: FestivalData = JSON.parse(dataText);

          // What the competition server checks before using a bundle.
          assertEquals(validateData(data), []);
          assertEquals(await validateManifest(manifest, dataText, data), []);
          for (const a of manifest.audio) {
            const bytes = await Deno.readFile(
              join(first.folder, "audio", audioFileName(a)),
            );
            assertEquals(bytes.length, a.bytes);
            assertEquals(await sha256Hex(bytes), a.sha256);
          }
          assertEquals(manifest.audio.length, 3, "four uploads, one duplicate");
          assertEquals(manifest.loudness_target_lufs, -15);
          assertEquals(manifest.problems, []);

          const sessionsOut = data.festival.tracks[0].sessions;
          assertEquals(sessionsOut.map((s) => s.name), [
            "Afternoon",
            "Evening",
          ]);
          assertEquals(sessionsOut[1].start_time, "2026-10-20T18:00:00Z");
          assertEquals(sessionsOut[1].competitions.map((c) => c.name), [
            "Couples",
            "Solo",
          ], "empty competition left out");
          assertEquals(data.festival.rubrics[0].judges.map((j) => j.name), [
            "Judge Ada",
          ]);
          assertEquals(
            sessionsOut[1].competitions[0].competitors[0].audio.announce
              ?.content_type,
            "audio/mpeg",
          );

          for (
            const secret of [
              "@example",
              "@private",
              "password",
              "pbkdf2",
              "kim@",
              "members",
            ]
          ) {
            assert(!dataText.includes(secret), `data.json leaks ${secret}`);
            assert(
              !JSON.stringify(manifest).includes(secret),
              `manifest leaks ${secret}`,
            );
          }

          const zip = await new Deno.Command("unzip", {
            args: ["-tq", first.zip],
            stdout: "piped",
          }).output();
          assert(zip.success, new TextDecoder().decode(zip.stdout));

          const [row] = await ctx
            .sql`SELECT data_text, digest FROM exports WHERE id = ${first.id}`;
          assertEquals(
            row.data_text,
            dataText,
            "the exact data.json text is kept",
          );

          // Same data, a second later: same bytes, same digest.
          await new Promise((res) => setTimeout(res, 1100));
          const again = await exportFestival(ctx, fid, { final: false });
          assertEquals(again.digest, first.digest);
          assertEquals(
            await Deno.readTextFile(join(again.folder, "data.json")),
            dataText,
          );
        },
      );

      await t.step(
        "problems are surfaced, and block a silent final export",
        async () => {
          // Kim replaces the couple's announcement with a file ffmpeg cannot decode.
          const junk = new Uint8Array([
            ...new TextEncoder().encode("RIFF"),
            0,
            0,
            0,
            0,
            ...new TextEncoder().encode("WAVE"),
            1,
            2,
            3,
          ]);
          const f = new FormData();
          f.append("file", new File([junk], "broken.wav"));
          r = await sam.post(`/entries/${samCouples.id}/audio/announce`, f);
          assertStringIncludes(redirected(r).ok ?? "", "uploaded");
          await drain(ctx);
          const [bad] = await ctx
            .sql`SELECT status, reason FROM audio_files WHERE entry_id = ${samCouples.id} AND kind = 'announce'`;
          assertEquals(bad.status, "failed");
          assertStringIncludes(bad.reason, "could not decode");

          const page = await (await admin.get(`/admin/f/${fid}/export`)).text();
          assertStringIncludes(page, "1 audio problem(s)");
          r = await admin.post(`/admin/f/${fid}/export`, { kind: "final" });
          assertStringIncludes(redirected(r).err ?? "", "will not be exported");
          r = await admin.post(`/admin/f/${fid}/export`, { kind: "dry" });
          assertStringIncludes(
            redirected(r).ok ?? "",
            "1 problem file(s) left out",
            redirected(r).err ?? "",
          );
          const [x] = await ctx
            .sql`SELECT manifest_text, digest FROM exports ORDER BY id DESC LIMIT 1`;
          assertEquals(JSON.parse(x.manifest_text).problems, [
            {
              competition_id: couples.id,
              competitor_id: samKimId,
              kind: "announce",
              reason: `failed: ${bad.reason}`,
            },
          ]);
          assertNotEquals(x.digest, first.digest);
        },
      );

      // --- freeze ---------------------------------------------------------------------
      await t.step(
        "freeze: competitors can no longer change anything, the organiser can",
        async () => {
          r = await admin.post(`/admin/f/${fid}/freeze`);
          assertEquals(r.status, 303);
          const f = new FormData();
          f.append(
            "file",
            new File([tone as Uint8Array<ArrayBuffer>], "late.wav"),
          );
          r = await sam.post(`/entries/${samCouples.id}/audio/announce`, f);
          assertStringIncludes(redirected(r).err ?? "", "frozen");
          r = await alex.post(`/entries/${alexCouples.id}/withdraw`);
          assertStringIncludes(redirected(r).err ?? "", "frozen");
          r = await alex.post("/entries", {
            competitor_id: String(alexId),
            competition_id: String(comps[2].id),
            duration: "60",
          });
          assertStringIncludes(redirected(r).err ?? "", "not open");

          // The organiser fixes the announcement after the freeze, then reorders.
          const g = new FormData();
          g.append(
            "file",
            new File([tone as Uint8Array<ArrayBuffer>], "fixed.wav"),
          );
          r = await admin.post(
            `/entries/${samCouples.id}/audio/announce?to=admin`,
            g,
          );
          assertStringIncludes(redirected(r).ok ?? "", "uploaded");
          await drain(ctx);
          r = await admin.post(`/admin/entries/${alexCouples.id}/move`, {
            position: "1",
          });
          assertEquals(r.status, 303);
          const order = await ctx
            .sql`SELECT competitor_id FROM entries WHERE competition_id = ${couples.id} ORDER BY order_number`;
          assertEquals(order.map((e) => e.competitor_id), [alexId, samKimId]);
        },
      );

      // --- final export and the venue -------------------------------------------------
      r = await admin.post(`/admin/f/${fid}/export`, { kind: "final" });
      assertStringIncludes(redirected(r).ok ?? "", "Final bundle exported");
      const [finalExport] = await ctx.sql<
        { id: number; digest: string; data_text: string }[]
      >`
        SELECT id, digest, data_text FROM exports WHERE final`;

      await t.step("after the final export nothing changes", async () => {
        r = await admin.post(`/admin/tracks`, {
          festival_id: String(fid),
          name: "Late track",
        });
        assertStringIncludes(redirected(r).err ?? "", "final bundle");
        r = await admin.post(`/admin/f/${fid}/export`, { kind: "dry" });
        assertStringIncludes(redirected(r).err ?? "", "already been exported");
      });

      // The venue token is shown once, on the page.
      const tokenPage = await (await admin.post(`/admin/f/${fid}/token`))
        .text();
      const token = /<code>([A-Za-z0-9_-]{40,})<\/code>/.exec(tokenPage)?.[1];
      assert(token, "token shown");
      const api = (
        method: string,
        path: string,
        body?: unknown,
        extra: Record<string, string> = {},
      ) =>
        admin.request(method, path, {
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...extra,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });

      await t.step("HTTPS bundle pull with Range", async () => {
        assertEquals(
          (await admin.request("GET", "/api/bundle", {
            headers: { authorization: "Bearer nope" },
          })).status,
          403,
        );
        const info = await (await api("GET", "/api/bundle")).json();
        assertEquals(info.export_id, finalExport.id);
        assertEquals(info.final, true);
        const manifest: BundleManifest = await (await api(
          "GET",
          `/api/bundle/${info.export_id}/manifest.json`,
        )).json();
        const data =
          await (await api("GET", `/api/bundle/${info.export_id}/data.json`))
            .text();
        assertEquals(data, finalExport.data_text);
        const a = manifest.audio[0];
        const part = await api(
          "GET",
          `/api/bundle/${info.export_id}/audio/${audioFileName(a)}`,
          undefined,
          { range: "bytes=10-" },
        );
        assertEquals(part.status, 206);
        assertEquals((await part.arrayBuffer()).byteLength, a.bytes - 10);
        assertEquals(
          (await api(
            "GET",
            `/api/bundle/${info.export_id}/audio/${"0".repeat(64)}.mp3`,
          )).status,
          404,
        );
      });

      await t.step(
        "score receiver: replace, digest checks, stale pushes",
        async () => {
          const data: FestivalData = JSON.parse(finalExport.data_text);
          const coupleComp =
            data.festival.tracks[0].sessions[1].competitions[0];
          const [c1, c2] = data.festival.rubrics[0].criteria.map((c) => c.id);
          const row = (
            competitor_id: number,
            criteria_id: number,
            score: number,
          ) => ({
            competition_id: coupleComp.id,
            competitor_id,
            judge_id: ada.id,
            criteria_id,
            score,
          });
          const push = (
            scores: ReturnType<typeof row>[],
            sent_at: string,
            extra = {},
          ) => ({
            festival_id: fid,
            bundle_digest: finalExport.digest,
            digest: crypto.randomUUID(),
            final: false,
            sent_at,
            scores,
            skips: [],
            ...extra,
          });

          r = await api(
            "POST",
            "/api/scores",
            push([row(alexId, c1, 7.5)], "2026-10-20T19:00:00Z", {
              bundle_digest: "f".repeat(64),
            }),
          );
          assertEquals(r.status, 409);
          r = await api(
            "POST",
            "/api/scores",
            push([row(alexId, c1, 7.5)], "2026-10-20T19:00:00Z", {
              festival_id: fid + 1,
            }),
          );
          assertEquals(r.status, 403);
          r = await api(
            "POST",
            "/api/scores",
            push([row(9999, c1, 7.5)], "2026-10-20T19:00:00Z"),
          );
          assertEquals(r.status, 422);

          r = await api(
            "POST",
            "/api/scores",
            push(
              [
                row(alexId, c1, 7.5),
                row(alexId, c2, 8),
                row(samKimId, c1, 9),
                row(samKimId, c2, 9.5),
              ],
              "2026-10-20T19:00:00Z",
            ),
          );
          assertEquals(await r.json(), { ok: true, applied: true });
          assertEquals(
            (await ctx.sql`SELECT count(*)::int AS n FROM scores`)[0].n,
            4,
          );

          // A correction that deletes a score: the snapshot replaces everything.
          r = await api(
            "POST",
            "/api/scores",
            push(
              [
                row(alexId, c1, 7.5),
                row(samKimId, c1, 9),
                row(samKimId, c2, 9.5),
              ],
              "2026-10-20T19:01:00Z",
              { final: true },
            ),
          );
          assertEquals((await r.json()).applied, true);
          assertEquals(
            (await ctx.sql`SELECT count(*)::int AS n FROM scores`)[0].n,
            3,
          );

          // An older snapshot arriving late is ignored.
          r = await api(
            "POST",
            "/api/scores",
            push([row(alexId, c1, 1)], "2026-10-20T18:59:00Z"),
          );
          assertEquals(await r.json(), {
            ok: true,
            applied: false,
            reason: "stale",
          });
          assertEquals(
            (await ctx.sql`SELECT count(*)::int AS n FROM scores`)[0].n,
            3,
          );

          const results = await (await admin.get(`/admin/f/${fid}/results`))
            .text();
          assertStringIncludes(results, "final results received");
          assertStringIncludes(results, "Sam and Kim");
          assertStringIncludes(results, "28"); // 9 x 1 + 9.5 x 2
          const log = await ctx
            .sql`SELECT accepted FROM score_pushes ORDER BY id`;
          assertEquals(log.map((l) => l.accepted), [
            false,
            false,
            false,
            true,
            true,
            true,
          ]);
        },
      );

      await t.step("auth: magic link and password reset", async () => {
        const anon = new Client(ctx);
        await anon.post("/magic", { email: "alex@example.com" });
        const link = /http:\/\/portal\.test(\/magic\/\S+)/.exec(
          ctx.mailer.sent.at(-1)!.text,
        )![1];
        assertEquals(
          (await anon.get(link)).status,
          200,
          "GET only shows a button",
        );
        r = await anon.post(link);
        assertEquals(redirected(r).path, "/me");
        assertEquals((await anon.get("/me")).status, 200);
        assertStringIncludes(
          redirected(await new Client(ctx).post(link)).err ?? "",
          "expired or was already used",
        );

        await new Client(ctx).post("/forgot", { email: "sam@example.com" });
        const reset = /http:\/\/portal\.test(\/reset\/\S+)/.exec(
          ctx.mailer.sent.at(-1)!.text,
        )![1];
        r = await new Client(ctx).post(reset, {
          password: "a brand new password",
        });
        assertEquals(redirected(r).path, "/me");
        assertEquals(
          (await sam.get("/me")).status,
          303,
          "other sessions signed out",
        );
        r = await new Client(ctx).post("/login", {
          email: "sam@example.com",
          password: "a brand new password",
        });
        assertEquals(redirected(r).path, "/me");
        assertEquals(ctx.mailer.sent.length, 2);
        await new Client(ctx).post("/forgot", { email: "nobody@example.com" });
        assertEquals(
          ctx.mailer.sent.length,
          2,
          "no mail, and no hint, for unknown addresses",
        );
      });

      await t.step("forms need a same-site origin", async () => {
        const res = await admin.request("POST", "/admin/festivals", {
          form: { name: "x" },
          headers: { origin: "https://evil.example" },
        });
        assertEquals(res.status, 403);
      });
    } finally {
      await cleanup();
    }
  },
});
