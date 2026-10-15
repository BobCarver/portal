/**
 * Categories end to end over HTTP: gender, age and level are checked when
 * entering, when members or profiles change, when a competition's rules change,
 * and again at export. A refused change leaves everything as it was.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import type { AppContext } from "../../src/context.ts";
import { exportFestival } from "../../src/export/exporter.ts";
import {
  Client,
  databaseAvailable,
  redirected,
  testContext,
} from "../helpers.ts";

const ok = await databaseAvailable();

async function person(
  ctx: AppContext,
  email: string,
  name: string,
  gender: "male" | "female",
  dob: string,
  level: "amateur" | "professional",
): Promise<Client> {
  const c = new Client(ctx);
  const r = await c.post("/register", {
    name,
    email,
    password: "a long enough password",
  });
  assertEquals(r.status, 303, await r.text());
  const p = await c.post("/profile", { gender, date_of_birth: dob, level });
  assertEquals(redirected(p).ok, "Profile saved.");
  return c;
}

const idOf = (path: string) => Number(path.split("/").pop());

Deno.test({
  name: "categories: gender, age and level agree for every entry",
  ignore: !ok,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { ctx, cleanup } = await testContext();
    try {
      // --- the festival and its competitions ------------------------------------
      const admin = new Client(ctx);
      await admin.post("/register", {
        name: "Org",
        email: "org@example.com",
        password: "a long enough password",
      });
      await ctx.sql`UPDATE users SET is_admin = true`;
      let r = await admin.post("/admin/festivals", { name: "Autumn" });
      const fid = Number(redirected(r).path.split("/")[3]);
      await admin.post(`/admin/f/${fid}/settings`, {
        name: "Autumn",
        registration_open: "1",
        age_on: "2026-10-20",
        tz_offset: "0",
      });
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

      const comp = async (
        name: string,
        gender: string,
        level: string,
        min_age = "",
        max_age = "",
      ) => {
        const res = await admin.post("/admin/competitions", {
          festival_id: String(fid),
          name,
          rubric_id: String(rubric.id),
          session_id: "",
          gender,
          level,
          min_age,
          max_age,
        });
        assertEquals(res.status, 303, name);
        const [row] = await ctx
          .sql`SELECT id FROM competitions WHERE name = ${name}`;
        return row.id as number;
      };
      const womenAm = await comp(
        "Women · Amateur · Solo",
        "female",
        "amateur",
        "18",
        "40",
      );
      const mixedProAm = await comp(
        "Mixed · Pro-am · Couples",
        "mixed",
        "pro_am",
      );
      const sameAm = await comp(
        "Same-gender · Amateur · Couples",
        "same_gender",
        "amateur",
        "18",
        "60",
      );

      // --- people ---------------------------------------------------------------
      const dana = await person(
        ctx,
        "dana@example.com",
        "Dana",
        "female",
        "1990-05-01",
        "amateur",
      );
      const sam = await person(
        ctx,
        "sam@example.com",
        "Sam",
        "male",
        "1988-03-12",
        "professional",
      );
      await person(
        ctx,
        "lou@example.com",
        "Lou",
        "female",
        "1993-11-02",
        "amateur",
      );
      const max = await person(
        ctx,
        "max@example.com",
        "Max",
        "male",
        "2009-01-01",
        "amateur",
      ); // 17
      const noProfile = new Client(ctx);
      await noProfile.post("/register", {
        name: "New",
        email: "new@example.com",
        password: "a long enough password",
      });

      const makeCompetitor = async (c: Client, name: string, type: string) =>
        idOf(redirected(await c.post("/competitors", { name, type })).path);
      const enter = (c: Client, competitorId: number, competitionId: number) =>
        c.post("/entries", {
          competitor_id: String(competitorId),
          competition_id: String(competitionId),
        });

      // --- refusals on entering ---------------------------------------------------
      const danaSolo = await makeCompetitor(dana, "Dana", "individual");
      await admin.post(`/admin/f/${fid}/settings`, {
        name: "Autumn",
        registration_open: "1",
        age_on: "2026-10-20",
        tz_offset: "0",
      });

      await t("a person without a profile cannot enter", async () => {
        const id = await makeCompetitor(noProfile, "New", "individual");
        r = await enter(noProfile, id, womenAm);
        assertStringIncludes(redirected(r).err ?? "", "has not set gender");
      });

      let samSolo = 0;
      await t("a man cannot enter a women's competition", async () => {
        const id = (samSolo = await makeCompetitor(sam, "Sam", "individual"));
        r = await enter(sam, id, womenAm);
        assertStringIncludes(
          redirected(r).err ?? "",
          "this competition is women, and the entry is men",
        );
      });

      await t(
        "a woman in the right band enters a women's competition",
        async () => {
          r = await enter(dana, danaSolo, womenAm);
          assertStringIncludes(redirected(r).ok ?? "", "Entered");
        },
      );

      await t(
        "the age band is checked, on the festival's age date",
        async () => {
          const id = await makeCompetitor(max, "Max", "individual");
          r = await enter(max, id, womenAm);
          assertStringIncludes(
            redirected(r).err ?? "",
            "not within the age band 18 to 40",
          );
        },
      );

      const danaSam = await makeCompetitor(dana, "Dana and Sam", "couple");
      await dana.post(`/competitors/${danaSam}/members`, {
        email: "sam@example.com",
      });

      await t(
        "a couple of a woman and a man is mixed: a mixed pro-am couple enters",
        async () => {
          r = await enter(dana, danaSam, mixedProAm);
          assertStringIncludes(redirected(r).ok ?? "", "Entered");
        },
      );

      const danaLou = await makeCompetitor(dana, "Dana and Lou", "couple");
      await dana.post(`/competitors/${danaLou}/members`, {
        email: "lou@example.com",
      });

      await t("a pair of two amateurs is not a pro-am couple", async () => {
        r = await enter(dana, danaLou, mixedProAm);
        assertStringIncludes(
          redirected(r).err ?? "",
          "pro-am competition needs at least one professional",
        );
      });

      await t(
        "two women are a same-gender couple, for the same-gender competition",
        async () => {
          r = await enter(dana, danaLou, sameAm);
          assertStringIncludes(redirected(r).ok ?? "", "Entered");
        },
      );

      await t(
        "a mixed couple cannot enter the same-gender competition",
        async () => {
          r = await enter(dana, danaSam, sameAm);
          assertStringIncludes(
            redirected(r).err ?? "",
            "this competition is same-gender couples, and the entry is mixed",
          );
        },
      );

      await t(
        "the enter form offers only what this competitor may enter, and only for the user's own competitors",
        async () => {
          const offered = async (competitorId: number) =>
            await (await dana.get(
              `/festivals/${fid}/enter?competitor=${competitorId}`,
            )).text();
          const solo = await offered(danaSolo);
          assertStringIncludes(solo, "Women · Amateur · Solo");
          assert(
            !solo.includes("Mixed · Pro-am · Couples"),
            "solo sees a couples event",
          );
          assertStringIncludes(solo, "competition(s) are not shown");
          const pair = await offered(danaSam);
          assertStringIncludes(pair, "Mixed · Pro-am · Couples");
          assert(
            !pair.includes("Women · Amateur · Solo"),
            "couple sees the solo",
          );
          // Sam's own competitor is not Dana's to use: it falls back to hers.
          assertEquals(await offered(samSolo), solo);
        },
      );

      await t("a couple has exactly two people", async () => {
        const id = await makeCompetitor(dana, "Alone", "couple");
        r = await enter(dana, id, mixedProAm);
        assertStringIncludes(
          redirected(r).err ?? "",
          "a couple needs exactly two members",
        );
      });

      // --- changes that could break an entry -------------------------------------
      await t(
        "a member cannot be added to a couple that already has two",
        async () => {
          r = await dana.post(`/competitors/${danaSam}/members`, {
            email: "lou@example.com",
          });
          assertStringIncludes(
            redirected(r).err ?? "",
            "A couple has two members",
          );
        },
      );

      await t(
        "changing your gender re-checks your entries, and refuses one that breaks",
        async () => {
          r = await dana.post("/profile", {
            gender: "male",
            date_of_birth: "1990-05-01",
            level: "amateur",
          });
          assertStringIncludes(
            redirected(r).err ?? "",
            "would make an entry ineligible",
          );
          const [row] = await ctx
            .sql`SELECT gender FROM users WHERE email = 'dana@example.com'`;
          assertEquals(row.gender, "female", "nothing changed");
        },
      );

      await t(
        "an organiser cannot change a competition's rules under existing entries",
        async () => {
          r = await admin.post(`/admin/competitions/${womenAm}`, {
            name: "Women · Amateur · Solo",
            rubric_id: String(rubric.id),
            session_id: "",
            gender: "male",
            level: "amateur",
            min_age: "18",
            max_age: "40",
          });
          assertStringIncludes(redirected(r).err ?? "", "nothing was saved");
          const [row] = await ctx
            .sql`SELECT gender FROM competitions WHERE id = ${womenAm}`;
          assertEquals(row.gender, "female");
        },
      );

      await t(
        "clearing the age date is refused while an age band depends on it",
        async () => {
          r = await admin.post(`/admin/f/${fid}/settings`, {
            name: "Autumn",
            registration_open: "1",
            tz_offset: "0",
          });
          assertStringIncludes(
            redirected(r).err ?? "",
            "no age reference date",
          );
          const [f] = await ctx
            .sql`SELECT to_char(age_on,'YYYY-MM-DD') AS age_on FROM festivals WHERE id = ${fid}`;
          assertEquals(f.age_on, "2026-10-20");
        },
      );

      await t(
        "an age band needs the festival's age date (a festival without one)",
        async () => {
          await admin.post("/admin/festivals", { name: "No date yet" });
          const [other] = await ctx
            .sql`SELECT id FROM festivals WHERE name = 'No date yet'`;
          await admin.post("/admin/rubrics", {
            festival_id: String(other.id),
            name: "R2",
          });
          const [rubric2] = await ctx
            .sql`SELECT id FROM rubrics WHERE festival_id = ${other.id}`;
          r = await admin.post("/admin/competitions", {
            festival_id: String(other.id),
            name: "Needs a date",
            rubric_id: String(rubric2.id),
            session_id: "",
            gender: "open",
            level: "open",
            min_age: "18",
            max_age: "",
          });
          assertStringIncludes(
            redirected(r).err ?? "",
            "Set the festival's age date",
          );
        },
      );

      await t("an age date must be a real date", async () => {
        r = await admin.post(`/admin/f/${fid}/settings`, {
          name: "Autumn",
          registration_open: "1",
          age_on: "2026-02-31",
          tz_offset: "0",
        });
        assertStringIncludes(redirected(r).err ?? "", "not a real date");
      });

      await t("a new age date that breaks an entry is refused", async () => {
        // Dana is 36 on 20 Oct 2026; on 1 Jan 2000 she is 9, too young for the band.
        r = await admin.post(`/admin/f/${fid}/settings`, {
          name: "Autumn",
          registration_open: "1",
          age_on: "2000-01-01",
          tz_offset: "0",
        });
        assertStringIncludes(redirected(r).err ?? "", "nothing was saved");
        const [f] = await ctx
          .sql`SELECT to_char(age_on,'YYYY-MM-DD') AS age_on FROM festivals WHERE id = ${fid}`;
        assertEquals(f.age_on, "2026-10-20");
      });

      // --- the export refuses an illegal entry, even one put there by hand ---------
      await admin.post("/admin/tracks", {
        festival_id: String(fid),
        name: "Main",
        location: "",
      });
      const [track] = await ctx.sql`SELECT id FROM tracks`;
      await admin.post("/admin/sessions", {
        track_id: String(track.id),
        name: "Evening",
        start_time: "2027-04-01T18:00",
        tz_offset: "0",
      });
      const [session] = await ctx.sql`SELECT id FROM sessions`;
      for (const id of [womenAm, mixedProAm, sameAm]) {
        const [c] = await ctx
          .sql`SELECT name FROM competitions WHERE id = ${id}`;
        await admin.post(`/admin/competitions/${id}`, {
          name: c.name,
          rubric_id: String(rubric.id),
          session_id: String(session.id),
          gender:
            (await ctx.sql`SELECT gender FROM competitions WHERE id = ${id}`)[0]
              .gender,
          level:
            (await ctx.sql`SELECT level FROM competitions WHERE id = ${id}`)[0]
              .level,
          min_age:
            (await ctx.sql`SELECT min_age FROM competitions WHERE id = ${id}`)[
              0
            ].min_age ?? "",
          max_age:
            (await ctx.sql`SELECT max_age FROM competitions WHERE id = ${id}`)[
              0
            ].max_age ?? "",
          open: "1",
        });
      }

      await t("a competition's rules are checked again at export", async () => {
        // Bypass the portal's checks to simulate a bad row.
        await ctx
          .sql`UPDATE competitions SET gender = 'male' WHERE id = ${womenAm}`;
        r = await admin.post(`/admin/f/${fid}/export`, { kind: "dry" });
        assertStringIncludes(redirected(r).err ?? "", "is not eligible");
        assertStringIncludes(redirected(r).err ?? "", "Dana");
        await ctx
          .sql`UPDATE competitions SET gender = 'female' WHERE id = ${womenAm}`;
      });

      await t(
        "a legal festival exports, and no personal detail reaches the bundle",
        async () => {
          const [user] = await ctx
            .sql`SELECT id FROM users WHERE email = 'org@example.com'`;
          // Remove the illegal entries first: the portal's own checks keep the
          // remaining ones legal, and the export proves it.
          const x = await exportFestival(ctx, fid, {
            final: false,
            userId: user.id,
          });
          const text = await Deno.readTextFile(join(x.folder, "data.json"));
          // Birth dates must not appear at all. Category fields must not appear
          // as keys (the competition names may say "Same-gender" for people).
          for (
            const dob of [
              "1990-05-01",
              "1988-03-12",
              "1993-11-02",
              "2009-01-01",
            ]
          ) {
            assert(!text.includes(dob), `data.json mentions a birth date`);
          }
          assert(
            !/"(gender|level|min_age|max_age|date_of_birth|age_on)"\s*:/.test(
              text,
            ),
            "data.json has a category field",
          );
        },
      );
    } finally {
      await cleanup();
    }
  },
});

/** A named step: keeps the output readable when one refusal is wrong. */
async function t(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    throw new Error(`${name}: ${(err as Error).message}`);
  }
}
