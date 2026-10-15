/**
 * The planner against the database, over HTTP: compare variants, preview, apply.
 * Two judging panels, so two stages can run at once; one dancer in both, so
 * her competitions must land in different time slots.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { exportFestival } from "../../src/export/exporter.ts";
import {
  Client,
  databaseAvailable,
  redirected,
  testContext,
} from "../helpers.ts";

const ok = await databaseAvailable();

Deno.test({
  name: "plan: compare, preview and apply a schedule",
  ignore: !ok,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { ctx, cleanup } = await testContext();
    const sql = ctx.sql;
    try {
      const admin = new Client(ctx);
      await admin.post("/register", {
        name: "Org",
        email: "org@example.com",
        password: "a long enough password",
      });
      const [org] = await sql`UPDATE users SET is_admin = true RETURNING id`;

      // --- a festival with two panels and six competitions, built directly --
      const [f] = await sql`INSERT INTO festivals (name, registration_open)
        VALUES ('Spring', true) RETURNING id`;
      const judges = await sql`INSERT INTO judges (festival_id, name) VALUES
        (${f.id}, 'A1'), (${f.id}, 'A2'), (${f.id}, 'B1'), (${f.id}, 'B2') RETURNING id`;
      const rubric = async (name: string, judgeIds: number[]) => {
        const [r] = await sql`INSERT INTO rubrics (festival_id, name)
          VALUES (${f.id}, ${name}) RETURNING id`;
        const [c] =
          await sql`INSERT INTO criteria (rubric_id, name) VALUES (${r.id}, 'T') RETURNING id`;
        for (const j of judgeIds) {
          await sql`INSERT INTO judge_criteria VALUES (${j}, ${c.id})`;
        }
        return r.id as number;
      };
      const ra = await rubric("Panel A", [judges[0].id, judges[1].id]);
      const rb = await rubric("Panel B", [judges[2].id, judges[3].id]);

      // People with complete profiles (the exporter checks eligibility).
      const person = async (name: string) => {
        const [u] =
          await sql`INSERT INTO users (email, name, gender, date_of_birth, level)
          VALUES (${
            name.toLowerCase() + "@example.com"
          }, ${name}, 'female', '1990-01-01', 'amateur')
          RETURNING id`;
        const [p] = await sql`INSERT INTO competitors (name, type, created_by)
          VALUES (${name}, 'individual', ${u.id}) RETURNING id`;
        await sql`INSERT INTO competitor_members VALUES (${p.id}, ${u.id})`;
        return p.id as number;
      };
      const dana = await person("Dana");
      const others = await Promise.all(
        ["Kim", "Lou", "Max", "Jo", "Ray", "Sue", "Tom", "Ann"].map(person),
      );

      // Each competition: entries with cached music lengths (seconds).
      const competition = async (
        name: string,
        rubricId: number,
        entrants: number[],
        seconds: number,
      ) => {
        const [c] =
          await sql`INSERT INTO competitions (festival_id, name, rubric_id)
          VALUES (${f.id}, ${name}, ${rubricId}) RETURNING id`;
        for (const [i, p] of entrants.entries()) {
          await sql`INSERT INTO entries (competition_id, competitor_id, duration, order_number)
            VALUES (${c.id}, ${p}, ${seconds}, ${i + 1})`;
        }
        return c.id as number;
      };
      await competition("A solo 1", ra, [dana, others[0]], 240);
      await competition("A solo 2", ra, [others[1], others[2]], 240);
      await competition("A solo 3", ra, [others[3]], 300);
      await competition("B solo 1", rb, [dana, others[4]], 240);
      await competition("B solo 2", rb, [others[5], others[6]], 240);
      await competition("B solo 3", rb, [others[7]], 300);
      await sql`INSERT INTO competitions (festival_id, name, rubric_id)
        VALUES (${f.id}, 'Nobody entered', ${ra})`;

      // --- compare and preview ---------------------------------------------
      const pageText = await (await admin.get(
        `/admin/f/${f.id}/plan?stages=3&smin=1&smax=3&start=2027-05-01T09:00&tz_offset=0&break=15&allowance=60`,
      )).text();
      assertStringIncludes(pageText, "6 competition(s) with entries");
      assertStringIncludes(
        pageText,
        "1 competition(s) without entries are left unscheduled",
      );
      assertStringIncludes(pageText, "best");
      assertStringIncludes(pageText, "Apply this plan");

      // --- apply 2 stages x 2 sessions ---------------------------------------
      const r = await admin.post(`/admin/f/${f.id}/plan/apply`, {
        t: "2",
        s: "2",
        starts_at: "2027-05-01T09:00:00.000Z",
        break: "15",
        allowance: "60",
      });
      // Exactly this: no problems (clashes, unusable stages) appended.
      assertEquals(
        redirected(r).ok,
        "Plan applied: 4 session(s) on 2 stage(s).",
      );

      const tracks =
        await sql`SELECT id, name FROM tracks WHERE festival_id = ${f.id} ORDER BY id`;
      assertEquals(
        tracks.map((t) => t.name),
        ["Stage 1", "Stage 2"],
        "stages were created",
      );

      const scheduled = await sql`
        SELECT c.name, c.rubric_id, c.order_number, s.track_id, s.order_number AS slot,
          s.start_time
        FROM competitions c JOIN sessions s ON s.id = c.session_id
        WHERE c.festival_id = ${f.id} ORDER BY s.track_id, s.order_number, c.order_number`;
      assertEquals(
        scheduled.length,
        6,
        "every competition with entries is scheduled",
      );

      // Each panel stays on one stage: judges never change stage.
      const stagesOf = (rubricId: number) =>
        new Set(
          scheduled.filter((x) => x.rubric_id === rubricId).map((x) =>
            x.track_id
          ),
        );
      assertEquals(stagesOf(ra).size, 1);
      assertEquals(stagesOf(rb).size, 1);
      assert(
        [...stagesOf(ra)][0] !== [...stagesOf(rb)][0],
        "the panels are on different stages",
      );

      // Dana's two performances, worked out from what was written (session
      // start, then each entry's music plus one minute in running order), are
      // on different stages and at least her performance plus 10 minutes apart.
      const timeline = await sql`
        SELECT s.track_id, s.start_time, c.order_number AS c_order,
          e.order_number AS e_order, e.duration, e.competitor_id
        FROM sessions s JOIN competitions c ON c.session_id = s.id
          JOIN entries e ON e.competition_id = c.id
        WHERE c.festival_id = ${f.id}
        ORDER BY s.id, c.order_number, e.order_number`;
      const danaAt: { track: number; at: number }[] = [];
      let session = "", at = 0;
      for (const row of timeline) {
        const key = `${row.track_id}/${row.start_time.toISOString()}`;
        if (key !== session) {
          session = key;
          at = row.start_time.getTime();
        }
        if (row.competitor_id === dana) {
          danaAt.push({ track: row.track_id, at });
        }
        at += (row.duration + 60) * 1000;
      }
      assertEquals(danaAt.length, 2);
      assert(
        danaAt[0].track !== danaAt[1].track,
        "one performance on each stage",
      );
      const apart = Math.abs(danaAt[0].at - danaAt[1].at);
      assert(
        apart >= (240 + 60 + 600) * 1000,
        `only ${apart / 60_000} minutes apart`,
      );

      // Entries keep a clean running order 1..n in every competition.
      const orders = await sql`
        SELECT competition_id, array_agg(order_number ORDER BY order_number) AS o
        FROM entries GROUP BY competition_id`;
      for (const o of orders) {
        assertEquals(o.o, o.o.map((_: number, i: number) => i + 1));
      }

      // Parallel slots: both stages start each slot at the same time, with a break.
      const starts = [
        ...new Set(scheduled.map((x) => x.start_time.toISOString())),
      ].sort();
      assertEquals(starts[0], "2027-05-01T09:00:00.000Z");
      assertEquals(starts.length, 2);
      assert(
        Date.parse(starts[1]) > Date.parse(starts[0]),
        "the second slot comes later",
      );

      const [unscheduled] =
        await sql`SELECT session_id FROM competitions WHERE name = 'Nobody entered'`;
      assertEquals(unscheduled.session_id, null);

      // The planned festival still exports (music is missing, so as a dry run).
      const x = await exportFestival(ctx, f.id, {
        final: false,
        userId: org.id,
      });
      assert(x.digest.length === 64);

      // Applying again with the same settings gives the same schedule.
      await admin.post(`/admin/f/${f.id}/plan/apply`, {
        t: "2",
        s: "2",
        starts_at: "2027-05-01T09:00:00.000Z",
        break: "15",
        allowance: "60",
      });
      const again = await sql`
        SELECT c.name, c.order_number, s.order_number AS slot, s.start_time
        FROM competitions c JOIN sessions s ON s.id = c.session_id
        WHERE c.festival_id = ${f.id} ORDER BY c.name`;
      assertEquals(
        again.map((
          a,
        ) => [a.name, a.order_number, a.slot, a.start_time.toISOString()]),
        scheduled.toSorted((a, b) => a.name < b.name ? -1 : 1)
          .map((
            a,
          ) => [a.name, a.order_number, a.slot, a.start_time.toISOString()]),
      );
    } finally {
      await cleanup();
    }
  },
});
