import type { Hono } from "@hono/hono";
import { type AppEnv, back, type C, needAdmin, page } from "../app.ts";
import { type AppContext, nowOf } from "../context.ts";
import { UserError } from "../errors.ts";
import { assertAdminCanEdit, festivalState } from "../festival.ts";
import { int, parseLocalDateTime, str } from "../http.ts";
import { applyPlan, loadPlanInput, type PlanInput } from "../plan/db.ts";
import {
  compareVariants,
  competitionSeconds,
  makePlan,
  type Plan,
  type PlanSettings,
} from "../plan/planner.ts";
import { type Html, html } from "../views/html.ts";
import { postButton, time } from "../views/layout.ts";
import { dateInput, stateLine, tabs } from "./admin.ts";

/**
 * The organiser's planning page (portal.md section 2b): compare numbers of
 * stages and sessions, preview one plan, apply it. The plan is recomputed on
 * apply from the same settings, so what is applied is what was previewed.
 */

/** "1 h 05 min" or "42 min". */
const hm = (seconds: number) => {
  const m = Math.round(seconds / 60);
  return m >= 60
    ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`
    : `${m} min`;
};

type Base = Omit<PlanSettings, "tracks" | "sessionsPerTrack">;

interface PlanForm {
  maxStages: number;
  minSessions: number;
  maxSessions: number;
  base: Base;
}

const bounded = (n: number, lo: number, hi: number, what: string) => {
  if (!Number.isInteger(n) || n < lo || n > hi) {
    throw new UserError(
      `${what} must be a whole number from ${lo} to ${hi}.`,
      422,
    );
  }
  return n;
};

/** The settings in the query (GET) or form (POST), with defaults. */
async function formFrom(
  ctx: AppContext,
  fid: number,
  q: (name: string) => string,
): Promise<PlanForm> {
  const num = (
    name: string,
    def: number,
  ) => (q(name) === "" ? def : Number(q(name)));
  let startsAt: Date;
  if (q("starts_at")) {
    // From a preview link or the apply form: the exact instant that was shown.
    startsAt = new Date(q("starts_at"));
    if (Number.isNaN(startsAt.getTime())) {
      throw new UserError("Bad start time.", 422);
    }
  } else if (q("start")) {
    startsAt = parseLocalDateTime(q("start"), Number(q("tz_offset") || 0));
  } else {
    // Default: the current first session, else the festival's age date at 09:00.
    const [row] = await ctx.sql<
      { first: Date | null; age_on: string | null }[]
    >`
      SELECT (SELECT min(s.start_time) FROM sessions s JOIN tracks t ON t.id = s.track_id
          WHERE t.festival_id = f.id) AS first,
        to_char(f.age_on, 'YYYY-MM-DD') AS age_on
      FROM festivals f WHERE f.id = ${fid}`;
    startsAt = row?.first ??
      (row?.age_on ? new Date(`${row.age_on}T09:00:00Z`) : new Date(
        Math.ceil(nowOf(ctx).getTime() / 86_400_000) * 86_400_000 +
          9 * 3_600_000,
      ));
  }
  const minSessions = bounded(
    num("smin", 1),
    1,
    12,
    "Sessions per stage (from)",
  );
  return {
    maxStages: bounded(num("stages", 3), 1, 8, "Stages"),
    minSessions,
    maxSessions: bounded(
      num("smax", 4),
      minSessions,
      12,
      "Sessions per stage (to)",
    ),
    base: {
      startsAt,
      breakMinutes: bounded(num("break", 15), 0, 240, "The break"),
      gapMinutes: bounded(
        num("gap", 10),
        0,
        240,
        "The gap between performances",
      ),
      allowanceSeconds: bounded(
        num("allowance", 60),
        0,
        600,
        "The time per entry",
      ),
    },
  };
}

/** The base settings as form or query fields. */
const baseFields = (b: Base) => ({
  starts_at: b.startsAt.toISOString(),
  break: b.breakMinutes,
  gap: b.gapMinutes,
  allowance: b.allowanceSeconds,
});

export function planRoutes(app: Hono<AppEnv>, ctx: AppContext) {
  const fidOf = (c: C) => {
    const n = Number(c.req.param("fid"));
    if (!Number.isInteger(n) || n <= 0) throw new UserError("Not found.", 404);
    return n;
  };

  app.get("/admin/f/:fid/plan", async (c) => {
    needAdmin(c);
    const fid = fidOf(c);
    const state = await festivalState(ctx.sql, fid, nowOf(ctx));
    const input = await loadPlanInput(ctx.sql, fid);
    const form = await formFrom(ctx, fid, (n) => c.req.query(n) ?? "");
    const variants = compareVariants(
      input.competitions,
      form.base,
      form.maxStages,
      form.minSessions,
      form.maxSessions,
    );
    const t = Number(c.req.query("t")), s = Number(c.req.query("s"));
    const preview = t >= 1 && s >= 1
      ? makePlan(input.competitions, {
        ...form.base,
        tracks: t,
        sessionsPerTrack: s,
      })
      : variants[0];
    const total = input.competitions.reduce(
      (n, x) => n + competitionSeconds(x, form.base.allowanceSeconds),
      0,
    );
    const entries = input.competitions.reduce(
      (n, x) => n + x.entries.length,
      0,
    );
    const query = (extra: Record<string, number>) =>
      "?" + new URLSearchParams(Object.fromEntries(
        Object.entries({
          stages: form.maxStages,
          smin: form.minSessions,
          smax: form.maxSessions,
          ...baseFields(form.base),
          ...extra,
        }).map(([k, v]) => [k, String(v)]),
      ));

    return page(
      c,
      `${state.festival.name}: plan`,
      html`
        <h1>${state.festival.name}</h1>${tabs(fid, "plan")} ${stateLine(state)}
        <div class="card">
          <p>
            ${input.competitions
              .length} competition(s) with entries, ${entries} entries, ${input
              .judges.length}
            judge(s); ${hm(total)} in all.
          </p>
          ${input.withoutMusic
            ? html`
              <p class="small" style="color:var(--warn)">
                ${input.withoutMusic === 1
                  ? "1 entry has"
                  : `${input.withoutMusic} entries have`} no music yet, so they count as 0 seconds of music.
              </p>
            `
            : ""} ${input.withoutEntries
            ? html`
              <p class="small muted">
                ${input
                  .withoutEntries} competition(s) without entries are left unscheduled.
              </p>
            `
            : ""}
          <p class="small muted">
            Competitions that share a judge stay on one stage, so judges never change
            stage. Each entry takes its music plus the time per entry; stages run their
            sessions in the same time slots, with a break after each slot. Nobody
            performs on two stages less than the gap apart: the running order inside
            competitions and sessions is changed only where that is needed.
          </p>
        </div>
        <form class="card row" method="get" action="/admin/f/${fid}/plan">
          <label>Stages, up to <input
              type="number"
              name="stages"
              min="1"
              max="8"
              value="${form.maxStages}"
              style="width:64px"
            ></label>
          <label>Sessions per stage, from <input
              type="number"
              name="smin"
              min="1"
              max="12"
              value="${form.minSessions}"
              style="width:64px"
            ></label>
          <label>to <input
              type="number"
              name="smax"
              min="1"
              max="12"
              value="${form.maxSessions}"
              style="width:64px"
            ></label>
          <label>First session ${dateInput(
            "start",
            form.base.startsAt,
            true,
          )}</label>
          <label>Break (minutes) <input
              type="number"
              name="break"
              min="0"
              max="240"
              value="${form.base.breakMinutes}"
              style="width:72px"
            ></label>
          <label>Gap between one person's performances (minutes) <input
              type="number"
              name="gap"
              min="0"
              max="240"
              value="${form.base.gapMinutes}"
              style="width:72px"
            ></label>
          <label>Time per entry (seconds) <input
              type="number"
              name="allowance"
              min="0"
              max="600"
              value="${form.base.allowanceSeconds}"
              style="width:72px"
            ></label>
          <button>Compare</button>
        </form>
        ${input.competitions.length === 0
          ? html`
            <p class="muted">Nothing to plan yet: no competition has entries.</p>
          `
          : html`
            <h2>Variants</h2>
            <div class="card tablewrap">
              <table>
                <tr>
                  <th>Stages</th>
                  <th>Sessions per stage</th>
                  <th>Clashes</th>
                  <th>Empty sessions</th>
                  <th>Session length</th>
                  <th>Judge changes</th>
                  <th>Entries moved</th>
                  <th>Finishes</th>
                  <th></th>
                </tr>
                ${variants.map((v, i) => variantRow(v, i === 0, query))}
              </table>
            </div>
            ${planView(preview, input, state.adminCanEdit, fid)}
          `}
      `,
    );
  });

  app.post("/admin/f/:fid/plan/apply", async (c) => {
    const user = needAdmin(c);
    const fid = fidOf(c);
    assertAdminCanEdit(await festivalState(ctx.sql, fid, nowOf(ctx)));
    const f = await c.req.parseBody();
    const form = await formFrom(ctx, fid, (n) => str(f, n));
    const plan = await applyPlan(ctx, fid, {
      ...form.base,
      tracks: bounded(int(f, "t"), 1, 8, "Stages"),
      sessionsPerTrack: bounded(int(f, "s"), 1, 12, "Sessions per stage"),
    }, user.id);
    return back(c, `/admin/f/${fid}/structure`, {
      ok:
        `Plan applied: ${plan.sessions.length} session(s) on ${plan.settings.tracks} stage(s).` +
        (plan.problems.length ? ` ${plan.problems.join(" ")}` : ""),
    });
  });
}

function variantRow(
  v: Plan,
  best: boolean,
  query: (extra: Record<string, number>) => string,
): Html {
  const sc = v.score;
  const clashes = sc.judgeClashes + sc.peopleClashes;
  return html`
    <tr>
      <td>${v.settings.tracks}</td>
      <td>${v.settings.sessionsPerTrack}</td>
      <td>${clashes
        ? html`
          <span style="color:var(--bad)">${clashes}</span>
        `
        : "0"}</td>
      <td>${sc.emptySessions || ""}</td>
      <td>${hm(sc.shortestSeconds)} – ${hm(sc.longestSeconds)}</td>
      <td>${sc.judgeChanges}</td>
      <td>${sc.entriesMoved || ""}</td>
      <td class="small">${time(sc.endsAt)}</td>
      <td>
        <a href="${query({
          t: v.settings.tracks,
          s: v.settings.sessionsPerTrack,
        })}#preview">
          Preview</a>${best
            ? html`
              <span class="pill ready">best</span>
            `
            : ""}
      </td>
    </tr>
  `;
}

function planView(
  plan: Plan,
  input: PlanInput,
  canApply: boolean,
  fid: number,
): Html {
  const T = plan.settings.tracks, S = plan.settings.sessionsPerTrack;
  const comp = new Map(input.competitions.map((x) => [x.id, x]));
  const judge = new Map(input.judges.map((j) => [j.id, j.name]));
  const stage = (t: number) => input.tracks[t]?.name ?? `Stage ${t + 1} (new)`;
  const slots = Array.from(
    { length: S },
    (_, k) => plan.sessions.filter((x) => x.slot === k),
  );
  return html`
    <h2 id="preview">
      Plan: ${T} stage(s), ${S} session(s) per stage
    </h2>
    ${plan.problems.length
      ? html`
        <div class="card problems">
          <ul>${plan.problems.map((p) =>
            html`
              <li>${p}</li>
            `
          )}</ul>
          ${plan.clashes.length
            ? html`
              <ul class="small">${plan.clashes.slice(0, 20).map((x) =>
                html`
                  <li>
                    ${input.people.get(x.person) ??
                      `person ${x.person}`}: ${comp.get(x.competitions[0])
                      ?.name} ${time(x.at[0])} and ${comp.get(x.competitions[1])
                      ?.name} ${time(x.at[1])}
                  </li>
                `
              )}</ul>
            `
            : ""}
        </div>
      `
      : ""} ${plan.score.entriesMoved
      ? html`
        <p class="small muted">
          ${plan.score.entriesMoved} entr${plan.score.entriesMoved === 1
            ? "y is"
            : "ies are"} moved from the current running order, to keep
          someone's performances apart.
        </p>
      `
      : ""}
    <div class="card tablewrap">
      <table>
        <tr><th>Slot</th>${Array.from({ length: T }, (_, t) =>
          html`
            <th>${stage(t)}</th>
          `)}</tr>
        ${slots.map((sessions, k) =>
          html`
            <tr>
              <td class="small">${sessions[0]
                ? time(sessions[0].startsAt)
                : ""}</td>
              ${Array.from({ length: T }, (_, t) => {
                const x = sessions.find((y) => y.track === t);
                if (!x) {
                  return html`
                    <td class="muted small">(free)</td>
                  `;
                }
                return html`
                  <td>
                    <strong>Session ${k + 1}</strong>
                    <span class="small muted">${hm(x.seconds)}</span>
                    <div class="small muted">Judges: ${x.judges.map((j) =>
                      judge.get(j) ?? j
                    ).join(", ") || "none"}</div>
                    <ol class="small" style="margin:4px 0 0 18px;padding:0">${x
                      .competitions.map((pc) =>
                        html`
                          <li>${comp.get(pc.id)?.name} <span class="muted">(${pc
                            .entryIds.length}, ${time(pc.startsAt)})</span></li>
                        `
                      )}</ol>
                  </td>
                `;
              })}
            </tr>
          `
        )}
      </table>
    </div>
    ${canApply
      ? postButton(`/admin/f/${fid}/plan/apply`, "Apply this plan", {
        cls: "",
        confirm:
          "Apply this plan? It replaces every session and the running order of " +
          "competitions and their entries. Competitions without entries become unscheduled.",
        fields: { t: T, s: S, ...baseFields(plan.settings) },
      })
      : html`
        <p class="muted small">
          The final bundle has been exported: the plan can no longer change.
        </p>
      `}
  `;
}
