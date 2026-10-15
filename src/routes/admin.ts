import type { Hono } from "@hono/hono";
import { type AppEnv, back, type C, needAdmin, page } from "../app.ts";
import type { AudioFileRow } from "../audio/audio.ts";
import { rejectAudio } from "../audio/audio.ts";
import { type AppContext, nowOf } from "../context.ts";
import { randomToken, sha256Hex } from "../crypto.ts";
import { logEvent, type Tx } from "../db.ts";
import { UserError } from "../errors.ts";
import { assertEntriesEligible } from "../categories.ts";
import {
  COMPETITION_GENDERS,
  COMPETITION_LEVELS,
  type CompetitionGender,
  type CompetitionLevel,
  type CompetitionRules,
  GENDER_LABEL,
  LEVEL_LABEL,
  rulesLabel,
} from "../eligibility.ts";
import {
  buildBundle,
  exportFestival,
  ExportRefused,
  prepareExport,
  readSnapshot,
} from "../export/exporter.ts";
import {
  assertAdminCanEdit,
  festivalOf,
  type FestivalState,
  festivalState,
} from "../festival.ts";
import {
  fileResponse,
  int,
  parseIsoDate,
  parseLocalDateTime,
  required,
  str,
} from "../http.ts";
import {
  closeGaps,
  idsInOrder,
  moveBy,
  moveTo,
  nextOrder,
  renumber,
} from "../order.ts";
import { tallyResults } from "../scores.ts";
import { type Html, html } from "../views/html.ts";
import {
  megabytes,
  postButton,
  seconds,
  statusPill,
  time,
} from "../views/layout.ts";
import { withdraw } from "../entries.ts";
import { audioBlock } from "./competitor.ts";
import { dataOnlyZip } from "./api.ts";

const TABS = [
  ["", "Overview"],
  ["structure", "Tracks and sessions"],
  ["plan", "Plan"],
  ["rubrics", "Rubrics and judges"],
  ["entries", "Entries and audio"],
  ["export", "Export"],
  ["results", "Results"],
] as const;

export function tabs(fid: number, on: string): Html {
  return html`
    <nav class="tabs">${TABS.map(([path, label]) =>
      html`
        <a class="${path === on ? "on" : ""}" href="/admin/f/${fid}${path
          ? `/${path}`
          : ""}">${label}</a>
      `
    )}</nav>
  `;
}

export function stateLine(s: FestivalState): Html {
  if (s.final) {
    return html`
      <p>
        <span class="pill ready">final bundle exported</span> Nothing can change now.
      </p>
    `;
  }
  if (s.frozen) {
    return html`
      <p>
        <span class="pill processing">frozen</span> Registration and competitor
        uploads are closed. Resolve problems, finalise the running order, then export.
      </p>
    `;
  }
  return html`
    <p>
      ${s.festival.registration_open
        ? html`
          <span class="pill ready">registration open</span>
        `
        : html`
          <span class="pill">registration closed</span>
        `} ${s.festival.freeze_at
        ? html`
          Freezes ${time(s.festival.freeze_at)}.
        `
        : html`
          No freeze time set.
        `}
    </p>
  `;
}

/** `datetime-local` input showing a UTC time in the browser's zone (page script). */
export const dateInput = (name: string, d: Date | null, required = false) =>
  html`
    <input type="datetime-local" name="${name}" ${required
      ? "required"
      : ""} ${d
      ? html`
        data-utc="${d.toISOString()}" value="${d.toISOString().slice(0, 16)}"
      `
      : ""}>
    <input type="hidden" name="tz_offset" value="0">
  `;

/** The category fields of a competition form (gender, level, age band). */
function rulesFields(k?: Partial<CompetitionRules>): Html {
  const gender = k?.gender ?? "open";
  const level = k?.level ?? "open";
  return html`
    <span class="row" style="gap:6px">
      <select name="gender" title="Gender">${COMPETITION_GENDERS.map((v) =>
        html`
          <option value="${v}" ${v === gender
            ? "selected"
            : ""}>${GENDER_LABEL[v]}</option>
        `
      )}</select>
      <select name="level" title="Level">${COMPETITION_LEVELS.map((v) =>
        html`
          <option value="${v}" ${v === level
            ? "selected"
            : ""}>${LEVEL_LABEL[v]}</option>
        `
      )}</select>
      <input
        type="number"
        name="min_age"
        min="0"
        max="120"
        placeholder="min age"
        title="Youngest age (on the festival's age date)"
        value="${k?.min_age ?? ""}"
        style="width:84px"
      >
      <input
        type="number"
        name="max_age"
        min="0"
        max="120"
        placeholder="max age"
        title="Oldest age"
        value="${k?.max_age ?? ""}"
        style="width:84px"
      >
    </span>
  `;
}

/** The category fields from a competition form, checked. */
function rulesFrom(f: Record<string, unknown>): CompetitionRules {
  const gender = str(f, "gender") || "open";
  const level = str(f, "level") || "open";
  if (!COMPETITION_GENDERS.includes(gender as CompetitionGender)) {
    throw new UserError("Choose a gender category.", 422);
  }
  if (!COMPETITION_LEVELS.includes(level as CompetitionLevel)) {
    throw new UserError("Choose a level.", 422);
  }
  const age = (name: string): number | null => {
    const v = str(f, name);
    if (!v) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 120) {
      throw new UserError("Ages are whole numbers from 0 to 120.", 422);
    }
    return n;
  };
  const min_age = age("min_age");
  const max_age = age("max_age");
  if (min_age !== null && max_age !== null && min_age > max_age) {
    throw new UserError("The youngest age is more than the oldest.", 422);
  }
  return {
    gender: gender as CompetitionGender,
    level: level as CompetitionLevel,
    min_age,
    max_age,
  };
}

export const dateFrom = (f: Record<string, unknown>, name: string) =>
  parseLocalDateTime(str(f, name), Number(str(f, "tz_offset") || 0));

export function adminRoutes(app: Hono<AppEnv>, ctx: AppContext) {
  const state = (fid: number) => festivalState(ctx.sql, fid, nowOf(ctx));
  /** Load a festival for an edit: refused after the final export. */
  const editable = async (fid: number) => {
    const s = await state(fid);
    assertAdminCanEdit(s);
    return s;
  };
  const form = (c: C) => c.req.parseBody() as Promise<Record<string, unknown>>;
  const id = (c: C, name = "id") => {
    const n = Number(c.req.param(name));
    if (!Number.isInteger(n) || n <= 0) throw new UserError("Not found.", 404);
    return n;
  };

  // --- festivals ------------------------------------------------------------------

  app.get("/admin", async (c) => {
    needAdmin(c);
    const festivals = await ctx.sql<
      { id: number; name: string; entries: number; final: boolean }[]
    >`
      SELECT f.id, f.name,
        (SELECT count(*)::int FROM entries e JOIN competitions c ON c.id = e.competition_id
          WHERE c.festival_id = f.id) AS entries,
        EXISTS (SELECT 1 FROM exports x WHERE x.festival_id = f.id AND x.final) AS final
      FROM festivals f ORDER BY f.id DESC`;
    return page(
      c,
      "Admin",
      html`
        <h1>Festivals</h1>
        ${festivals.map((f) =>
          html`
            <div class="card">
              <a href="/admin/f/${f.id}"><strong>${f.name}</strong></a>
              <span class="muted small"
              >#${f.id} · ${f.entries} entries${f.final
                ? " · final export done"
                : ""}</span>
            </div>
          `
        )}
        <form class="card row" method="post" action="/admin/festivals">
          <label>New festival <input
              type="text"
              name="name"
              required
              placeholder="Autumn Open"
            ></label>
          <button>Create</button>
        </form>
      `,
    );
  });

  app.post("/admin/festivals", async (c) => {
    const user = needAdmin(c);
    const name = required(await form(c), "name", "a name");
    const [f] = await ctx.sql<
      { id: number }[]
    >`INSERT INTO festivals (name) VALUES (${name}) RETURNING id`;
    await logEvent(ctx.sql, {
      festivalId: f.id,
      userId: user.id,
      kind: "festival.create",
      detail: name,
    });
    return back(c, `/admin/f/${f.id}/structure`, {
      ok: "Festival created. Add tracks, sessions and rubrics next.",
    });
  });

  // --- overview and settings -------------------------------------------------------

  const overview = async (c: C, fid: number, newToken?: string) => {
    const s = await state(fid);
    const f = s.festival;
    const [counts] = await ctx.sql<{
      entries: number;
      ready: number;
      processing: number;
      failed: number;
      missing: number;
      flagged: number;
    }[]>`
      SELECT count(*)::int AS entries,
        count(*) FILTER (WHERE m.status = 'ready')::int AS ready,
        count(*) FILTER (WHERE m.status = 'processing')::int AS processing,
        count(*) FILTER (WHERE m.status = 'failed')::int AS failed,
        count(*) FILTER (WHERE m.id IS NULL)::int AS missing,
        count(*) FILTER (WHERE m.flag IS NOT NULL)::int AS flagged
      FROM entries e JOIN competitions c ON c.id = e.competition_id
        LEFT JOIN audio_files m ON m.entry_id = e.id AND m.kind = 'music'
      WHERE c.festival_id = ${fid}`;
    const events = await ctx.sql<
      { at: Date; kind: string; detail: string; email: string | null }[]
    >`
      SELECT e.at, e.kind, e.detail, u.email FROM events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.festival_id = ${fid} ORDER BY e.id DESC LIMIT 25`;
    return page(
      c,
      f.name,
      html`
        <h1>${f.name}</h1>${tabs(fid, "")} ${stateLine(s)}
        <div class="card">
          <h2 style="margin-top:0">Entries</h2>
          <p>
            ${counts.entries} entries · music: ${counts.ready} ready, ${counts
              .processing} processing,
            ${counts.failed} failed, ${counts.missing} missing${counts.flagged
              ? `, ${counts.flagged} flagged`
              : ""} · <a
              href="/admin/f/${fid}/entries"
            >review</a>
          </p>
        </div>
        ${s.adminCanEdit
          ? html`
            <form
              class="card stack"
              method="post"
              action="/admin/f/${fid}/settings"
              style="max-width:560px"
            >
              <h2 style="margin-top:0">Settings</h2>
              <label>Name <input
                  type="text"
                  name="name"
                  value="${f.name}"
                  required
                ></label>
              <label><input type="checkbox" name="registration_open" value="1" ${f
                  .registration_open
                ? "checked"
                : ""}>
                Registration open (competitors can enter open competitions)</label>
              <label>Freeze time: registration and competitor uploads close
                ${dateInput("freeze_at", f.freeze_at)}</label>
              <label>Age date: ages in competitions with an age band are worked out on this
                day (usually the festival's first day)
                <input type="date" name="age_on" value="${f.age_on ??
                  ""}"></label>
              <label><input type="checkbox" name="order_published" value="1" ${f
                  .order_published
                ? "checked"
                : ""}>
                Show competitors their running position</label>
              <button>Save settings</button>
            </form>
            ${!s.frozen
              ? html`
                <p>${postButton(`/admin/f/${fid}/freeze`, "Freeze now", {
                  cls: "danger",
                  confirm:
                    "Close registration and uploads for competitors now?",
                })}</p>
              `
              : ""}
          `
          : ""}
        <div class="card">
          <h2 style="margin-top:0">Venue token</h2>
          <p class="small">
            The competition server uses this token to download the bundle and to push
            scores (<code>Authorization: Bearer …</code>). Generating a new one
            replaces the old.
          </p>
          ${newToken
            ? html`
              <p class="flash ok">
                New token (shown once, copy it now):<br><code>${newToken}</code>
              </p>
            `
            : html`
              <p>${f.api_token_hash ? "A token is set." : html`
                <span class="muted">No token yet.</span>
              `}</p>
            `}
          <p class="small">
            Score receiver: <code>${ctx.config.baseUrl}/api/scores</code><br>
            Bundle download: <code>${ctx.config.baseUrl}/api/bundle</code>
          </p>
          ${postButton(
            `/admin/f/${fid}/token`,
            f.api_token_hash ? "Generate a new token" : "Generate token",
            {
              confirm: f.api_token_hash
                ? "The old token stops working. Continue?"
                : undefined,
            },
          )}
        </div>
        <h2>Recent activity</h2>
        <div class="card tablewrap"><table>${events.map((e) =>
          html`
            <tr>
              <td class="small">${time(e.at)}</td>
              <td><code>${e.kind}</code></td>
              <td class="small">${e.detail}</td>
              <td class="small muted">${e.email ?? ""}</td>
            </tr>
          `
        )}</table></div>
      `,
    );
  };

  app.get("/admin/f/:fid", (c) => {
    needAdmin(c);
    return overview(c, id(c, "fid"));
  });

  app.post("/admin/f/:fid/settings", async (c) => {
    const user = needAdmin(c);
    const fid = id(c, "fid");
    await editable(fid);
    const f = await form(c);
    const freeze = str(f, "freeze_at") ? dateFrom(f, "freeze_at") : null;
    const ageOn = str(f, "age_on")
      ? parseIsoDate(str(f, "age_on"), "age date")
      : null;
    await ctx.sql.begin(async (tx) => {
      await tx`SELECT id FROM festivals WHERE id = ${fid} FOR UPDATE`;
      await tx`UPDATE festivals SET name = ${required(f, "name", "a name")},
        registration_open = ${
        f.registration_open === "1"
      }, freeze_at = ${freeze},
        order_published = ${f.order_published === "1"},
        age_on = ${ageOn}::date WHERE id = ${fid}`;
      // A new age date can move someone out of a band: refuse it if so.
      await assertEntriesEligible(tx, { festivalId: fid }, "That age date");
    });
    await logEvent(ctx.sql, {
      festivalId: fid,
      userId: user.id,
      kind: "festival.settings",
      detail: `registration ${
        f.registration_open === "1" ? "open" : "closed"
      }, freeze ${freeze?.toISOString() ?? "none"}`,
    });
    return back(c, `/admin/f/${fid}`, { ok: "Settings saved." });
  });

  app.post("/admin/f/:fid/freeze", async (c) => {
    const user = needAdmin(c);
    const fid = id(c, "fid");
    await editable(fid);
    await ctx.sql`UPDATE festivals SET freeze_at = ${
      nowOf(ctx)
    }, registration_open = false WHERE id = ${fid}`;
    await logEvent(ctx.sql, {
      festivalId: fid,
      userId: user.id,
      kind: "festival.freeze",
    });
    return back(c, `/admin/f/${fid}/export`, {
      ok: "Frozen. Resolve the problems below, then export.",
    });
  });

  app.post("/admin/f/:fid/token", async (c) => {
    const user = needAdmin(c);
    const fid = id(c, "fid");
    await state(fid);
    const token = randomToken();
    await ctx.sql`UPDATE festivals SET api_token_hash = ${await sha256Hex(
      token,
    )} WHERE id = ${fid}`;
    await logEvent(ctx.sql, {
      festivalId: fid,
      userId: user.id,
      kind: "festival.token",
    });
    // Rendered directly (not via a redirect) so the token never lands in a URL.
    return overview(c, fid, token);
  });

  // --- tracks, sessions, competitions ---------------------------------------------

  app.get("/admin/f/:fid/structure", async (c) => {
    needAdmin(c);
    const fid = id(c, "fid");
    const s = await state(fid);
    const tracks = await ctx.sql<
      { id: number; name: string; location: string }[]
    >`
      SELECT id, name, location FROM tracks WHERE festival_id = ${fid} ORDER BY id`;
    const sessions = await ctx.sql<
      {
        id: number;
        track_id: number;
        name: string;
        start_time: Date;
        order_number: number;
      }[]
    >`
      SELECT s.id, s.track_id, s.name, s.start_time, s.order_number FROM sessions s
      JOIN tracks t ON t.id = s.track_id WHERE t.festival_id = ${fid} ORDER BY s.order_number`;
    const competitions = await ctx.sql<{
      id: number;
      session_id: number | null;
      name: string;
      rubric_id: number;
      open: boolean;
      order_number: number | null;
      entries: number;
      gender: CompetitionGender;
      level: CompetitionLevel;
      min_age: number | null;
      max_age: number | null;
    }[]>`
      SELECT c.id, c.session_id, c.name, c.rubric_id, c.open, c.order_number,
        c.gender, c.level, c.min_age, c.max_age,
        (SELECT count(*)::int FROM entries e WHERE e.competition_id = c.id) AS entries
      FROM competitions c WHERE c.festival_id = ${fid}
      ORDER BY c.order_number, c.created_at, c.id`;
    const unscheduled = competitions.filter((k) => k.session_id === null);
    const rubrics = await ctx.sql<{ id: number; name: string }[]>`
      SELECT id, name FROM rubrics WHERE festival_id = ${fid} ORDER BY id`;
    const edit = s.adminCanEdit;
    const rubricSelect = (current?: number) =>
      html`
        <select name="rubric_id" required>${rubrics.map((r) =>
          html`
            <option value="${r.id}" ${r.id === current ? "selected" : ""}>${r
              .name}</option>
          `
        )}</select>
      `;
    const sessionSelect = (current: number | null) =>
      html`
        <select name="session_id">
          <option value="" ${current === null
            ? "selected"
            : ""}>not scheduled</option>
          ${tracks.map((t) =>
            sessions.filter((x) => x.track_id === t.id).map((x) =>
              html`
                <option value="${x.id}" ${x.id === current
                  ? "selected"
                  : ""}>${t
                  .name} · ${x.name}</option>
              `
            )
          )}
        </select>
      `;

    /** Competitions with no track and session yet, and the festival-level "new competition" form. */
    const unscheduledCard = () => {
      const waiting = unscheduled.filter((k) => k.entries > 0).length;
      if (!edit && unscheduled.length === 0) return "";
      // deno-fmt-ignore
      return html`<div class="card ${waiting ? "problems" : ""}">
        <h2 style="margin-top:0">Not scheduled yet</h2>
        ${waiting
          ? html`<p class="small">${waiting} competition(s) with entries have no track and session.
              The export is refused until every competition with entries is scheduled.</p>`
          : html`<p class="small muted">Competitors can enter these already. Choose a session to schedule
              one; it goes last in that session's running order.</p>`}
        ${unscheduled.length
          ? html`<div class="tablewrap"><table>
              <tr><th colspan="3">Competition · rubric · session · open</th><th>Entries</th><th></th></tr>
              ${unscheduled.map((k) => html`<tr>
                ${edit
                  ? html`<td colspan="3"><form class="row" method="post" action="/admin/competitions/${k.id}" style="margin:0">
                      <input type="text" name="name" value="${k.name}" required>
                      ${rubricSelect(k.rubric_id)} ${rulesFields(k)} ${sessionSelect(null)}
                      <label style="flex-direction:row;align-items:center"><input type="checkbox" name="open" value="1" ${k.open ? "checked" : ""}> open</label>
                      <button class="small secondary">Save</button></form></td>`
                  : html`<td colspan="3">${k.name}</td>`}
                <td>${k.entries}</td>
                <td>${edit && k.entries === 0
                  ? postButton(`/admin/competitions/${k.id}/delete`, "Delete", { cls: "danger small" })
                  : ""}</td></tr>`)}
            </table></div>`
          : ""}
        ${edit && rubrics.length
          ? html`<form class="row" method="post" action="/admin/competitions" style="margin-top:8px">
              <input type="hidden" name="festival_id" value="${fid}">
              <label>New competition <input type="text" name="name" required></label>
              <label>Rubric ${rubricSelect()}</label>
              ${rulesFields()}
              <label>Session ${sessionSelect(null)}</label>
              <button class="small">Add competition</button></form>`
          : ""}
      </div>`;
    };

    return page(
      c,
      `${s.festival.name}: structure`,
      html`
        <h1>${s.festival.name}</h1>${tabs(
          fid,
          "structure",
        )} ${rubrics.length === 0
          ? html`
            <p class="flash err">
              Create a <a href="/admin/f/${fid}/rubrics">rubric</a> first: every
              competition needs one.
            </p>
          `
          : ""}
        <p class="small muted">
          Sessions run in order of their planned start time. Competitions and entries
          follow their running order; use ↑ ↓ to change it.
        </p>
        ${unscheduledCard()} ${tracks.map((t) =>
          html`
            <div class="card">
              ${edit
                ? html`
                  <form class="row" method="post" action="/admin/tracks/${t
                    .id}">
                    <label>Track <input
                        type="text"
                        name="name"
                        value="${t.name}"
                        required
                      ></label>
                    <label>Location <input
                        type="text"
                        name="location"
                        value="${t.location}"
                      ></label>
                    <button class="small secondary">Save</button>
                    ${postButton(
                      `/admin/tracks/${t.id}/delete`,
                      "Delete track",
                      { cls: "danger small", confirm: "Delete this track?" },
                    )}
                  </form>
                `
                : html`
                  <h2 style="margin-top:0">
                    ${t.name} <span class="muted small">${t.location}</span>
                  </h2>
                `} ${sessions.filter((x) => x.track_id === t.id).map((x) =>
                  html`
                    <div class="card" style="margin-left:12px">
                      ${edit
                        ? html`
                          <form class="row" method="post" action="/admin/sessions/${x
                            .id}">
                            <label>Session ${x.order_number} <input
                                type="text"
                                name="name"
                                value="${x.name}"
                                required
                              ></label>
                            <label>Planned start ${dateInput(
                              "start_time",
                              x.start_time,
                              true,
                            )}</label>
                            <button class="small secondary">Save</button>
                            ${postButton(
                              `/admin/sessions/${x.id}/delete`,
                              "Delete session",
                              {
                                cls: "danger small",
                                confirm: "Delete this session?",
                              },
                            )}
                          </form>
                        `
                        : html`
                          <h3 style="margin-top:0">${x.order_number}. ${x
                            .name} · ${time(x.start_time)}</h3>
                        `}
                      <div class="tablewrap">
                        <table>
                          <tr>
                            <th>#</th>
                            ${edit
                              ? html`
                                <th colspan="3">Competition · rubric · session · open</th>
                              `
                              : html`
                                <th>Competition</th>
                                <th>Rubric</th>
                                <th>Open</th>
                              `}
                            <th>Entries</th>
                            <th></th>
                          </tr>
                          ${competitions.filter((k) => k.session_id === x.id)
                            .map((k) =>
                              html`
                                <tr>
                                  <td>${k.order_number}</td>
                                  ${edit
                                    ? html`
                                      <td colspan="3">
                                        <form
                                          class="row"
                                          method="post"
                                          action="/admin/competitions/${k.id}"
                                          style="margin:0"
                                        >
                                          <input type="text" name="name" value="${k
                                            .name}" required>
                                          ${rubricSelect(
                                            k.rubric_id,
                                          )} ${rulesFields(k)} ${sessionSelect(
                                            k.session_id,
                                          )}
                                          <label style="flex-direction:row;align-items:center"><input
                                              type="checkbox"
                                              name="open"
                                              value="1"
                                              ${k.open ? "checked" : ""}
                                            > open</label>
                                          <button class="small secondary">Save</button>
                                        </form>
                                      </td>
                                    `
                                    : html`
                                      <td>${k.name}</td><td>${rubrics.find((
                                        r,
                                      ) => r.id === k.rubric_id)?.name}</td>
                                      <td>${k.open ? "yes" : "no"}</td>
                                    `}
                                  <td>${k.entries}</td>
                                  <td>${edit
                                    ? html`
                                      ${postButton(
                                        `/admin/competitions/${k.id}/move`,
                                        "↑",
                                        { fields: { dir: "up" } },
                                      )} ${postButton(
                                        `/admin/competitions/${k.id}/move`,
                                        "↓",
                                        { fields: { dir: "down" } },
                                      )} ${k.entries === 0
                                        ? postButton(
                                          `/admin/competitions/${k.id}/delete`,
                                          "Delete",
                                          { cls: "danger small" },
                                        )
                                        : ""}
                                    `
                                    : ""}</td>
                                </tr>
                              `
                            )}
                        </table>
                      </div>
                      ${edit && rubrics.length
                        ? html`
                          <form
                            class="row"
                            method="post"
                            action="/admin/competitions"
                            style="margin-top:8px"
                          >
                            <input type="hidden" name="session_id" value="${x
                              .id}">
                            <label>New competition <input type="text" name="name" required></label>
                            <label>Rubric ${rubricSelect()}</label>
                            ${rulesFields()}
                            <button class="small">Add competition</button>
                          </form>
                        `
                        : ""}
                    </div>
                  `
                )} ${edit
                ? html`
                  <form
                    class="row"
                    method="post"
                    action="/admin/sessions"
                    style="margin-left:12px"
                  >
                    <input type="hidden" name="track_id" value="${t.id}">
                    <label>New session <input type="text" name="name" required></label>
                    <label>Planned start ${dateInput(
                      "start_time",
                      null,
                      true,
                    )}</label>
                    <button class="small">Add session</button>
                  </form>
                `
                : ""}
            </div>
          `
        )} ${edit
          ? html`
            <form class="card row" method="post" action="/admin/tracks">
              <input type="hidden" name="festival_id" value="${fid}">
              <label>New track <input
                  type="text"
                  name="name"
                  required
                  placeholder="Main floor"
                ></label>
              <label>Location <input
                  type="text"
                  name="location"
                  placeholder="Hall A"
                ></label>
              <button>Add track</button>
            </form>
          `
          : ""}
      `,
    );
  });

  app.post("/admin/tracks", async (c) => {
    needAdmin(c);
    const f = await form(c);
    const fid = int(f, "festival_id");
    await editable(fid);
    await ctx.sql`INSERT INTO tracks (festival_id, name, location)
      VALUES (${fid}, ${required(f, "name", "a name")}, ${str(f, "location")})`;
    return back(c, `/admin/f/${fid}/structure`, { ok: "Track added." });
  });

  app.post("/admin/tracks/:id", async (c) => {
    needAdmin(c);
    const fid = await festivalOf(ctx.sql, "track", id(c));
    await editable(fid);
    const f = await form(c);
    await ctx.sql`UPDATE tracks SET name = ${
      required(f, "name", "a name")
    }, location = ${str(f, "location")}
      WHERE id = ${id(c)}`;
    return back(c, `/admin/f/${fid}/structure`, { ok: "Track saved." });
  });

  app.post("/admin/tracks/:id/delete", async (c) => {
    needAdmin(c);
    const fid = await festivalOf(ctx.sql, "track", id(c));
    await editable(fid);
    const [n] = await ctx
      .sql`SELECT count(*)::int AS n FROM sessions WHERE track_id = ${id(c)}`;
    if (n.n > 0) throw new UserError("Delete the track's sessions first.", 409);
    await ctx.sql`DELETE FROM tracks WHERE id = ${id(c)}`;
    return back(c, `/admin/f/${fid}/structure`, { ok: "Track deleted." });
  });

  app.post("/admin/sessions", async (c) => {
    needAdmin(c);
    const f = await form(c);
    const trackId = int(f, "track_id");
    const fid = await festivalOf(ctx.sql, "track", trackId);
    await editable(fid);
    await ctx.sql.begin(async (tx) => {
      await tx`SELECT id FROM tracks WHERE id = ${trackId} FOR UPDATE`;
      await tx`INSERT INTO sessions (track_id, name, start_time, order_number)
        VALUES (${trackId}, ${required(f, "name", "a name")}, ${
        dateFrom(f, "start_time")
      },
          ${await nextOrder(tx, "sessions", trackId)})`;
      // Sessions are numbered by planned start.
      await closeGaps(tx, "sessions", trackId);
    });
    return back(c, `/admin/f/${fid}/structure`, { ok: "Session added." });
  });

  app.post("/admin/sessions/:id", async (c) => {
    needAdmin(c);
    const fid = await festivalOf(ctx.sql, "session", id(c));
    await editable(fid);
    const f = await form(c);
    await ctx.sql.begin(async (tx) => {
      const [s] = await tx<{ track_id: number }[]>`
        UPDATE sessions SET name = ${
        required(f, "name", "a name")
      }, start_time = ${dateFrom(f, "start_time")}
        WHERE id = ${id(c)} RETURNING track_id`;
      await closeGaps(tx, "sessions", s.track_id);
    });
    return back(c, `/admin/f/${fid}/structure`, { ok: "Session saved." });
  });

  app.post("/admin/sessions/:id/delete", async (c) => {
    needAdmin(c);
    const fid = await festivalOf(ctx.sql, "session", id(c));
    await editable(fid);
    const [n] = await ctx
      .sql`SELECT count(*)::int AS n FROM competitions WHERE session_id = ${
      id(c)
    }`;
    if (n.n > 0) {
      throw new UserError(
        "Move the session's competitions to another session, or unschedule them, first.",
        409,
      );
    }
    await ctx.sql.begin(async (tx) => {
      const [s] = await tx<
        { track_id: number }[]
      >`DELETE FROM sessions WHERE id = ${id(c)} RETURNING track_id`;
      await closeGaps(tx, "sessions", s.track_id);
    });
    return back(c, `/admin/f/${fid}/structure`, { ok: "Session deleted." });
  });

  /** An age band is worked out on the festival's age date, so it must be set. */
  const requireAgeDate = async (
    tx: Tx,
    fid: number,
    rules: CompetitionRules,
  ) => {
    if (rules.min_age === null && rules.max_age === null) return;
    const [f] = await tx<{ age_on: string | null }[]>`
      SELECT to_char(age_on, 'YYYY-MM-DD') AS age_on FROM festivals WHERE id = ${fid}`;
    if (!f.age_on) {
      throw new UserError(
        "Set the festival's age date (Overview, Settings) before giving a competition an age band.",
        422,
      );
    }
  };

  const checkRubric = async (fid: number, rubricId: number) => {
    if ((await festivalOf(ctx.sql, "rubric", rubricId)) !== fid) {
      throw new UserError("That rubric belongs to another festival.", 422);
    }
  };

  /** The session chosen in a form, or null for "not scheduled"; checked to be in `fid`. */
  const sessionFrom = async (f: Record<string, unknown>, fid: number) => {
    if (!str(f, "session_id")) return null;
    const sessionId = int(f, "session_id");
    if ((await festivalOf(ctx.sql, "session", sessionId)) !== fid) {
      throw new UserError("That session belongs to another festival.", 422);
    }
    return sessionId;
  };

  /** Put a competition last in `sessionId`, or unschedule it (null). The old session closes up. */
  const schedule = async (tx: Tx, cid: number, sessionId: number | null) => {
    const [old] = await tx<{ session_id: number | null }[]>`
      SELECT session_id FROM competitions WHERE id = ${cid} FOR UPDATE`;
    if (old.session_id === sessionId) return;
    if (sessionId !== null) {
      await tx`SELECT id FROM sessions WHERE id = ${sessionId} FOR UPDATE`;
    }
    const order = sessionId === null
      ? null
      : await nextOrder(tx, "competitions", sessionId);
    await tx`UPDATE competitions SET session_id = ${sessionId}, order_number = ${order}
      WHERE id = ${cid}`;
    if (old.session_id !== null) {
      await closeGaps(tx, "competitions", old.session_id);
    }
  };

  app.post("/admin/competitions", async (c) => {
    needAdmin(c);
    const f = await form(c);
    const fid = str(f, "festival_id")
      ? int(f, "festival_id")
      : await festivalOf(ctx.sql, "session", int(f, "session_id"));
    await editable(fid);
    const sessionId = await sessionFrom(f, fid);
    const rubricId = int(f, "rubric_id");
    await checkRubric(fid, rubricId);
    const name = required(f, "name", "a name");
    const rules = rulesFrom(f);
    await ctx.sql.begin(async (tx) => {
      await requireAgeDate(tx, fid, rules);
      const [k] = await tx<{ id: number }[]>`
        INSERT INTO competitions (festival_id, name, rubric_id, gender, level, min_age, max_age)
        VALUES (${fid}, ${name}, ${rubricId}, ${rules.gender}, ${rules.level},
          ${rules.min_age}, ${rules.max_age}) RETURNING id`;
      await schedule(tx, k.id, sessionId);
    });
    return back(c, `/admin/f/${fid}/structure`, {
      ok: sessionId === null
        ? "Competition added. Schedule it in a session before exporting."
        : "Competition added.",
    });
  });

  app.post("/admin/competitions/:id", async (c) => {
    needAdmin(c);
    const cid = id(c);
    const fid = await festivalOf(ctx.sql, "competition", cid);
    await editable(fid);
    const f = await form(c);
    const rubricId = int(f, "rubric_id");
    await checkRubric(fid, rubricId);
    const sessionId = await sessionFrom(f, fid);
    const name = required(f, "name", "a name");
    const rules = rulesFrom(f);
    await ctx.sql.begin(async (tx) => {
      // Locked like enter() locks it, so no entry is added between check and save.
      await tx`SELECT id FROM competitions WHERE id = ${cid} FOR UPDATE`;
      await requireAgeDate(tx, fid, rules);
      await tx`UPDATE competitions SET name = ${name}, rubric_id = ${rubricId},
        open = ${
        f.open === "1"
      }, gender = ${rules.gender}, level = ${rules.level},
        min_age = ${rules.min_age}, max_age = ${rules.max_age} WHERE id = ${cid}`;
      await assertEntriesEligible(tx, { competitionId: cid }, "Those rules");
      await schedule(tx, cid, sessionId);
    });
    return back(c, `/admin/f/${fid}/structure`, { ok: "Competition saved." });
  });

  app.post("/admin/competitions/:id/delete", async (c) => {
    needAdmin(c);
    const cid = id(c);
    const fid = await festivalOf(ctx.sql, "competition", cid);
    await editable(fid);
    const [n] = await ctx
      .sql`SELECT count(*)::int AS n FROM entries WHERE competition_id = ${cid}`;
    if (n.n > 0) {
      throw new UserError(
        "This competition has entries; remove them first.",
        409,
      );
    }
    await ctx.sql.begin(async (tx) => {
      await schedule(tx, cid, null);
      await tx`DELETE FROM competitions WHERE id = ${cid}`;
    });
    return back(c, `/admin/f/${fid}/structure`, { ok: "Competition deleted." });
  });

  /** ↑ ↓ or a position, for competitions in a session and entries in a competition. */
  const move = (level: "competitions" | "entries") => async (c: C) => {
    const user = needAdmin(c);
    const rowId = id(c);
    const fid = await festivalOf(
      ctx.sql,
      level === "entries" ? "entry" : "competition",
      rowId,
    );
    await editable(fid);
    const f = await form(c);
    const parentCol = level === "entries" ? "competition_id" : "session_id";
    await ctx.sql.begin(async (tx) => {
      const [row] = await tx<{ parent: number | null }[]>`
        SELECT ${tx(parentCol)} AS parent FROM ${
        tx(level)
      } WHERE id = ${rowId}`;
      if (row.parent === null) {
        throw new UserError(
          "Schedule the competition in a session first.",
          409,
        );
      }
      const parentTable = level === "entries" ? "competitions" : "sessions";
      await tx`SELECT id FROM ${
        tx(parentTable)
      } WHERE id = ${row.parent} FOR UPDATE`;
      const ids = await idsInOrder(tx, level, row.parent);
      const dir = str(f, "dir");
      const next = dir === "up" || dir === "down"
        ? moveBy(ids, rowId, dir === "up" ? -1 : 1)
        : moveTo(ids, rowId, int(f, "position"));
      await renumber(tx, level, row.parent, next);
      await logEvent(tx, {
        festivalId: fid,
        userId: user.id,
        kind: `order.${level}`,
        detail: `${level} ${rowId} ${dir || f.position}`,
      });
    });
    const to = level === "entries"
      ? `/admin/f/${fid}/entries#entry-${rowId}`
      : `/admin/f/${fid}/structure`;
    return back(c, to);
  };
  app.post("/admin/competitions/:id/move", move("competitions"));
  app.post("/admin/entries/:id/move", move("entries"));

  // --- rubrics, criteria, judges ---------------------------------------------------

  app.get("/admin/f/:fid/rubrics", async (c) => {
    needAdmin(c);
    const fid = id(c, "fid");
    const s = await state(fid);
    const edit = s.adminCanEdit;
    const rubrics = await ctx.sql<{ id: number; name: string; used: number }[]>`
      SELECT r.id, r.name, (SELECT count(*)::int FROM competitions c WHERE c.rubric_id = r.id) AS used
      FROM rubrics r WHERE r.festival_id = ${fid} ORDER BY r.id`;
    const criteria = await ctx.sql<
      { id: number; rubric_id: number; name: string; weight: number }[]
    >`
      SELECT c.id, c.rubric_id, c.name, c.weight FROM criteria c JOIN rubrics r ON r.id = c.rubric_id
      WHERE r.festival_id = ${fid} ORDER BY c.id`;
    const judges = await ctx.sql<
      { id: number; name: string; email: string | null }[]
    >`
      SELECT id, name, email FROM judges WHERE festival_id = ${fid} ORDER BY name`;
    const assigned = new Set(
      (await ctx.sql<{ judge_id: number; criterion_id: number }[]>`
        SELECT jc.judge_id, jc.criterion_id FROM judge_criteria jc JOIN judges j ON j.id = jc.judge_id
        WHERE j.festival_id = ${fid}`).map((r) =>
        `${r.judge_id}:${r.criterion_id}`
      ),
    );
    return page(
      c,
      `${s.festival.name}: rubrics`,
      html`
        <h1>${s.festival.name}</h1>${tabs(fid, "rubrics")}
        <h2>Judges</h2>
        <div class="card">
          <p class="small muted">
            Judges exist here only to be assigned to rubrics; they score on the
            competition server. Only judges assigned to a rubric are exported, by name.
          </p>
          <table>${judges.map((j) =>
            html`
              <tr>
                <td>${edit
                  ? html`
                    <form
                      class="row"
                      method="post"
                      action="/admin/judges/${j.id}"
                      style="margin:0"
                    >
                      <input type="text" name="name" value="${j.name}" required>
                      <input
                        type="email"
                        name="email"
                        value="${j.email ?? ""}"
                        placeholder="email (private)"
                      >
                      <button class="small secondary">Save</button>
                    </form>
                  `
                  : html`
                    ${j.name}
                  `}</td>
                <td>${edit
                  ? postButton(`/admin/judges/${j.id}/delete`, "Delete", {
                    cls: "danger small",
                    confirm: "Delete this judge?",
                  })
                  : ""}</td>
              </tr>
            `
          )}</table>
          ${edit
            ? html`
              <form class="row" method="post" action="/admin/judges" style="margin-top:8px">
                <input type="hidden" name="festival_id" value="${fid}">
                <label>New judge <input type="text" name="name" required></label>
                <label>Email (optional, private) <input type="email" name="email"></label>
                <button class="small">Add judge</button>
              </form>
            `
            : ""}
        </div>
        <h2>Rubrics</h2>
        ${rubrics.map((r) => {
          const crit = criteria.filter((k) => k.rubric_id === r.id);
          return html`
            <div class="card">
              ${edit
                ? html`
                  <form class="row" method="post" action="/admin/rubrics/${r
                    .id}">
                    <label>Rubric <input
                        type="text"
                        name="name"
                        value="${r.name}"
                        required
                      ></label>
                    <button class="small secondary">Save</button>
                    ${r.used === 0
                      ? postButton(
                        `/admin/rubrics/${r.id}/delete`,
                        "Delete rubric",
                        { cls: "danger small", confirm: "Delete this rubric?" },
                      )
                      : html`
                        <span class="small muted">used by ${r
                          .used} competition(s)</span>
                      `}
                  </form>
                `
                : html`
                  <h3 style="margin-top:0">${r.name}</h3>
                `}
              <h3>Criteria</h3>
              <table>${crit.map((k) =>
                html`
                  <tr>
                    <td>${edit
                      ? html`
                        <form
                          class="row"
                          method="post"
                          action="/admin/criteria/${k.id}"
                          style="margin:0"
                        >
                          <input type="text" name="name" value="${k
                            .name}" required>
                          <label style="flex-direction:row;align-items:center;gap:4px">weight
                            <input
                              type="number"
                              name="weight"
                              value="${k.weight}"
                              min="0.1"
                              step="0.1"
                              style="width:80px"
                              required
                            ></label>
                          <button class="small secondary">Save</button>
                        </form>
                      `
                      : html`
                        ${k.name} (weight ${k.weight})
                      `}</td>
                    <td>${edit
                      ? postButton(`/admin/criteria/${k.id}/delete`, "Delete", {
                        cls: "danger small",
                        confirm:
                          "Delete this criterion and its judge assignments?",
                      })
                      : ""}</td>
                  </tr>
                `
              )}</table>
              ${edit
                ? html`
                  <form class="row" method="post" action="/admin/criteria" style="margin-top:8px">
                    <input type="hidden" name="rubric_id" value="${r.id}">
                    <label>New criterion <input type="text" name="name" required></label>
                    <label>Weight <input
                        type="number"
                        name="weight"
                        value="1"
                        min="0.1"
                        step="0.1"
                        style="width:80px"
                      ></label>
                    <button class="small">Add criterion</button>
                  </form>
                `
                : ""}
              <h3>Judges and the criteria they score</h3>
              ${crit.length === 0 || judges.length === 0
                ? html`
                  <p class="small muted">Add criteria and judges first.</p>
                `
                : html`
                  <form method="post" action="/admin/rubrics/${r.id}/judges">
                    <div class="tablewrap">
                      <table>
                        <tr><th>Judge</th>${crit.map((k) =>
                          html`
                            <th>${k.name}</th>
                          `
                        )}</tr>
                        ${judges.map((j) =>
                          html`
                            <tr><td>${j.name}</td>${crit.map((k) =>
                              html`
                                <td>
                                  <input
                                    type="checkbox"
                                    name="jc"
                                    value="${j.id}:${k.id}"
                                    ${assigned.has(`${j.id}:${k.id}`)
                                      ? "checked"
                                      : ""}
                                    ${edit ? "" : "disabled"}
                                  >
                                </td>
                              `
                            )}</tr>
                          `
                        )}
                      </table>
                    </div>
                    ${edit
                      ? html`
                        <button class="small">Save assignments</button>
                      `
                      : ""}
                  </form>
                `}
            </div>
          `;
        })} ${edit
          ? html`
            <form class="card row" method="post" action="/admin/rubrics">
              <input type="hidden" name="festival_id" value="${fid}">
              <label>New rubric <input
                  type="text"
                  name="name"
                  required
                  placeholder="Standard"
                ></label>
              <button>Add rubric</button>
            </form>
          `
          : ""}
      `,
    );
  });

  app.post("/admin/judges", async (c) => {
    needAdmin(c);
    const f = await form(c);
    const fid = int(f, "festival_id");
    await editable(fid);
    await ctx.sql`INSERT INTO judges (festival_id, name, email)
      VALUES (${fid}, ${required(f, "name", "a name")}, ${
      str(f, "email") || null
    })`;
    return back(c, `/admin/f/${fid}/rubrics`, { ok: "Judge added." });
  });

  app.post("/admin/judges/:id", async (c) => {
    needAdmin(c);
    const fid = await festivalOf(ctx.sql, "judge", id(c));
    await editable(fid);
    const f = await form(c);
    await ctx.sql`UPDATE judges SET name = ${
      required(f, "name", "a name")
    }, email = ${str(f, "email") || null}
      WHERE id = ${id(c)}`;
    return back(c, `/admin/f/${fid}/rubrics`, { ok: "Judge saved." });
  });

  app.post("/admin/judges/:id/delete", async (c) => {
    needAdmin(c);
    const fid = await festivalOf(ctx.sql, "judge", id(c));
    await editable(fid);
    await ctx.sql`DELETE FROM judges WHERE id = ${id(c)}`;
    return back(c, `/admin/f/${fid}/rubrics`, { ok: "Judge deleted." });
  });

  app.post("/admin/rubrics", async (c) => {
    needAdmin(c);
    const f = await form(c);
    const fid = int(f, "festival_id");
    await editable(fid);
    await ctx.sql`INSERT INTO rubrics (festival_id, name) VALUES (${fid}, ${
      required(f, "name", "a name")
    })`;
    return back(c, `/admin/f/${fid}/rubrics`, {
      ok: "Rubric added. Add its criteria and judges.",
    });
  });

  app.post("/admin/rubrics/:id", async (c) => {
    needAdmin(c);
    const fid = await festivalOf(ctx.sql, "rubric", id(c));
    await editable(fid);
    await ctx.sql`UPDATE rubrics SET name = ${
      required(await form(c), "name", "a name")
    } WHERE id = ${id(c)}`;
    return back(c, `/admin/f/${fid}/rubrics`, { ok: "Rubric saved." });
  });

  app.post("/admin/rubrics/:id/delete", async (c) => {
    needAdmin(c);
    const fid = await festivalOf(ctx.sql, "rubric", id(c));
    await editable(fid);
    const [n] = await ctx
      .sql`SELECT count(*)::int AS n FROM competitions WHERE rubric_id = ${
      id(c)
    }`;
    if (n.n > 0) throw new UserError("Competitions use this rubric.", 409);
    await ctx.sql`DELETE FROM rubrics WHERE id = ${id(c)}`;
    return back(c, `/admin/f/${fid}/rubrics`, { ok: "Rubric deleted." });
  });

  const weightOf = (f: Record<string, unknown>) => {
    const w = Number(str(f, "weight") || 1);
    if (!(w > 0) || w > 100) {
      throw new UserError("The weight must be a positive number.", 422);
    }
    return w;
  };

  app.post("/admin/criteria", async (c) => {
    needAdmin(c);
    const f = await form(c);
    const rubricId = int(f, "rubric_id");
    const fid = await festivalOf(ctx.sql, "rubric", rubricId);
    await editable(fid);
    await ctx.sql`INSERT INTO criteria (rubric_id, name, weight)
      VALUES (${rubricId}, ${required(f, "name", "a name")}, ${weightOf(f)})`;
    return back(c, `/admin/f/${fid}/rubrics`, { ok: "Criterion added." });
  });

  app.post("/admin/criteria/:id", async (c) => {
    needAdmin(c);
    const fid = await festivalOf(ctx.sql, "criterion", id(c));
    await editable(fid);
    const f = await form(c);
    await ctx.sql`UPDATE criteria SET name = ${
      required(f, "name", "a name")
    }, weight = ${weightOf(f)}
      WHERE id = ${id(c)}`;
    return back(c, `/admin/f/${fid}/rubrics`, { ok: "Criterion saved." });
  });

  app.post("/admin/criteria/:id/delete", async (c) => {
    needAdmin(c);
    const fid = await festivalOf(ctx.sql, "criterion", id(c));
    await editable(fid);
    await ctx.sql`DELETE FROM criteria WHERE id = ${id(c)}`;
    return back(c, `/admin/f/${fid}/rubrics`, { ok: "Criterion deleted." });
  });

  /** Replace which judges score which criteria of one rubric. */
  app.post("/admin/rubrics/:id/judges", async (c) => {
    const user = needAdmin(c);
    const rubricId = id(c);
    const fid = await festivalOf(ctx.sql, "rubric", rubricId);
    await editable(fid);
    const body = await c.req.parseBody({ all: true });
    const raw = body.jc === undefined
      ? []
      : Array.isArray(body.jc)
      ? body.jc
      : [body.jc];
    const pairs = raw.map((v) => String(v).split(":").map(Number));
    const crit = new Set(
      (await ctx.sql<
        { id: number }[]
      >`SELECT id FROM criteria WHERE rubric_id = ${rubricId}`).map((r) =>
        r.id
      ),
    );
    const judges = new Set(
      (await ctx.sql<
        { id: number }[]
      >`SELECT id FROM judges WHERE festival_id = ${fid}`).map((r) => r.id),
    );
    for (const [j, k] of pairs) {
      if (!judges.has(j) || !crit.has(k)) {
        throw new UserError("Unknown judge or criterion.", 422);
      }
    }
    await ctx.sql.begin(async (tx) => {
      await tx`DELETE FROM judge_criteria WHERE criterion_id IN (SELECT id FROM criteria WHERE rubric_id = ${rubricId})`;
      if (pairs.length) {
        await tx`INSERT INTO judge_criteria ${
          tx(
            pairs.map(([judge_id, criterion_id]) => ({
              judge_id,
              criterion_id,
            })),
          )
        }`;
      }
      await logEvent(tx, {
        festivalId: fid,
        userId: user.id,
        kind: "rubric.judges",
        detail: `rubric ${rubricId}: ${pairs.length} assignment(s)`,
      });
    });
    return back(c, `/admin/f/${fid}/rubrics`, { ok: "Assignments saved." });
  });

  // --- entries and audio ------------------------------------------------------------

  app.get("/admin/f/:fid/entries", async (c) => {
    needAdmin(c);
    const fid = id(c, "fid");
    const s = await state(fid);
    const built = buildBundle(await readSnapshot(ctx, fid));
    const entries = await ctx.sql<{
      id: number;
      competition_id: number;
      competitor_id: number;
      competitor_name: string;
      competitor_type: string;
      duration: number;
      order_number: number;
      members: string;
    }[]>`
      SELECT e.id, e.competition_id, e.competitor_id, p.name AS competitor_name,
        p.type AS competitor_type, e.duration, e.order_number,
        (SELECT string_agg(u.email, ', ' ORDER BY u.email) FROM competitor_members m
          JOIN users u ON u.id = m.user_id WHERE m.competitor_id = p.id) AS members
      FROM entries e JOIN competitors p ON p.id = e.competitor_id
        JOIN competitions c ON c.id = e.competition_id
      WHERE c.festival_id = ${fid} ORDER BY e.order_number`;
    const competitions = await ctx.sql<
      {
        id: number;
        name: string;
        session_name: string | null;
        track_name: string | null;
        gender: CompetitionGender;
        level: CompetitionLevel;
        min_age: number | null;
        max_age: number | null;
      }[]
    >`
      SELECT c.id, c.name, s.name AS session_name, t.name AS track_name,
        c.gender, c.level, c.min_age, c.max_age
      FROM competitions c LEFT JOIN sessions s ON s.id = c.session_id
        LEFT JOIN tracks t ON t.id = s.track_id
      WHERE c.festival_id = ${fid}
      ORDER BY t.id NULLS LAST, s.start_time, s.order_number, c.order_number, c.name`;
    const files = await ctx.sql<AudioFileRow[]>`
      SELECT a.* FROM audio_files a JOIN entries e ON e.id = a.entry_id
        JOIN competitions c ON c.id = e.competition_id WHERE c.festival_id = ${fid}`;
    const fileOf = new Map(files.map((f) => [`${f.entry_id}:${f.kind}`, f]));
    const edit = s.adminCanEdit;
    const maxMb = ctx.config.maxUploadBytes / 1024 / 1024;

    return page(
      c,
      `${s.festival.name}: entries`,
      html`
        <h1>${s.festival.name}</h1>${tabs(fid, "entries")} ${stateLine(
          s,
        )} ${problemsCard(fid, built.problems, entries)} ${competitions.map(
          (k) => {
            const list = entries.filter((e) => e.competition_id === k.id);
            return html`
              <h2>
                ${k.name} <span class="muted small"
                >${rulesLabel(k)} · ${k.session_name
                  ? `${k.track_name} · ${k.session_name}`
                  : "not scheduled"} · ${list.length} entries</span>
              </h2>
              ${list.map((e) => {
                const music = fileOf.get(`${e.id}:music`);
                const announce = fileOf.get(`${e.id}:announce`);
                return html`
                  <details class="card" id="entry-${e.id}">
                    <summary>
                      <strong>${e.order_number}. ${e.competitor_name}</strong>
                      <span class="small muted">${e
                        .competitor_type} · ${e.duration > 0
                        ? seconds(e.duration)
                        : "no length yet"}</span>
                      · music ${statusPill(
                        music?.status ?? "missing",
                        music?.reason,
                      )} ${music?.flag
                        ? html`
                          <span title="${music.flag}">⚠</span>
                        `
                        : ""} ${announce
                        ? html`
                          · announcement ${statusPill(
                            announce.status,
                            announce.reason,
                          )}
                        `
                        : ""}
                    </summary>
                    <p class="small">
                      Members: ${e.members} · <a href="/entries/${e
                        .id}">entry page</a>
                    </p>
                    ${edit
                      ? html`
                        <p>
                          ${postButton(
                            `/admin/entries/${e.id}/move`,
                            "↑ earlier",
                            { fields: { dir: "up" } },
                          )} ${postButton(
                            `/admin/entries/${e.id}/move`,
                            "↓ later",
                            { fields: { dir: "down" } },
                          )}
                          <form class="inline" method="post" action="/admin/entries/${e
                            .id}/move">
                            <input
                              type="number"
                              name="position"
                              min="1"
                              max="${list.length}"
                              value="${e.order_number}"
                              style="width:64px"
                            >
                            <button class="secondary small">Move to</button>
                          </form>
                          ${postButton(
                            `/admin/entries/${e.id}/remove`,
                            "Remove entry",
                            {
                              cls: "danger small",
                              confirm:
                                `Remove ${e.competitor_name} from ${k.name}?`,
                            },
                          )}
                        </p>
                      `
                      : ""} ${(["music", "announce"] as const).map((kind) => {
                        const file = kind === "music" ? music : announce;
                        return html`
                          ${audioBlock(kind, file, {
                            canUpload: edit,
                            uploadAction:
                              `/entries/${e.id}/audio/${kind}?to=admin`,
                            maxMb,
                          })} ${file && edit
                            ? html`
                              <div class="row" style="margin:-8px 0 12px">
                                <a class="small" href="/audio/${file
                                  .id}/original">original</a>
                                ${file.status !== "processing"
                                  ? postButton(
                                    `/admin/audio/${file.id}/retry`,
                                    "Normalise again",
                                  )
                                  : ""}
                                <form
                                  class="inline row"
                                  method="post"
                                  action="/admin/audio/${file.id}/reject"
                                >
                                  <input type="text" name="reason" placeholder="reason" required>
                                  <button class="danger small">Reject file</button>
                                </form>
                              </div>
                            `
                            : ""}
                        `;
                      })}
                  </details>
                `;
              })}
            `;
          },
        )}
      `,
    );
  });

  app.post("/admin/entries/:id/remove", async (c) => {
    const user = needAdmin(c);
    const fid = await festivalOf(ctx.sql, "entry", id(c));
    await withdraw(ctx, user, id(c));
    return back(c, `/admin/f/${fid}/entries`, { ok: "Entry removed." });
  });

  const fileFestival = async (fileId: number) => {
    const [r] = await ctx.sql<
      { entry_id: number }[]
    >`SELECT entry_id FROM audio_files WHERE id = ${fileId}`;
    if (!r) throw new UserError("No such file.", 404);
    return {
      entryId: r.entry_id,
      fid: await festivalOf(ctx.sql, "entry", r.entry_id),
    };
  };

  app.post("/admin/audio/:id/reject", async (c) => {
    const user = needAdmin(c);
    const { fid, entryId } = await fileFestival(id(c));
    await editable(fid);
    await rejectAudio(
      ctx,
      id(c),
      required(await form(c), "reason", "a reason"),
      user.id,
    );
    return back(c, `/admin/f/${fid}/entries#entry-${entryId}`, {
      ok: "File rejected.",
    });
  });

  app.post("/admin/audio/:id/retry", async (c) => {
    const user = needAdmin(c);
    const { fid, entryId } = await fileFestival(id(c));
    await editable(fid);
    await ctx.sql.begin(async (tx) => {
      await tx`UPDATE audio_files SET status = 'processing', reason = NULL WHERE id = ${
        id(c)
      }`;
      await tx`INSERT INTO audio_jobs (audio_file_id) VALUES (${id(c)})`;
      await logEvent(tx, {
        festivalId: fid,
        userId: user.id,
        kind: "audio.retry",
        detail: `file ${id(c)} by hand`,
      });
    });
    ctx.wakeWorker?.();
    return back(c, `/admin/f/${fid}/entries#entry-${entryId}`, {
      ok: "Queued for normalisation.",
    });
  });

  // --- export -------------------------------------------------------------------------

  app.get("/admin/f/:fid/export", async (c) => {
    needAdmin(c);
    const fid = id(c, "fid");
    const s = await state(fid);
    const p = await prepareExport(ctx, fid);
    const entries = await ctx.sql<
      {
        competition_id: number;
        competitor_id: number;
        competitor_name: string;
        id: number;
      }[]
    >`
      SELECT e.id, e.competition_id, e.competitor_id, p.name AS competitor_name
      FROM entries e JOIN competitors p ON p.id = e.competitor_id
        JOIN competitions c ON c.id = e.competition_id WHERE c.festival_id = ${fid}`;
    const exports = await ctx.sql<{
      id: number;
      final: boolean;
      generated_at: Date;
      digest: string;
      problem_count: number;
      email: string | null;
    }[]>`
      SELECT x.id, x.final, x.generated_at, x.digest, x.problem_count, u.email
      FROM exports x LEFT JOIN users u ON u.id = x.created_by
      WHERE x.festival_id = ${fid} ORDER BY x.generated_at DESC`;
    const f = p.data.festival;
    const competitions = f.tracks.flatMap((t) =>
      t.sessions.flatMap((x) => x.competitions)
    );
    const bytes = p.manifest.audio.reduce((n, a) => n + a.bytes, 0);
    const canExport = !s.final && p.errors.length === 0;

    return page(
      c,
      `${s.festival.name}: export`,
      html`
        <h1>${s.festival.name}</h1>${tabs(fid, "export")} ${stateLine(
          s,
        )} ${p.errors.length
          ? html`
            <div class="card problems">
              <h2>The bundle cannot be exported</h2>
              <ul>${p.errors.map((e) =>
                html`
                  <li>${e}</li>
                `
              )}</ul>
            </div>
          `
          : ""} ${problemsCard(fid, p.problems, entries)} ${!s.final
          ? html`
            <div class="card">
              <h2 style="margin-top:0">Next export</h2>
              <p>
                ${f.tracks.length} track(s), ${f.tracks.reduce(
                  (n, t) => n + t.sessions.length,
                  0,
                )} session(s), ${competitions.length} competition(s)
                with entries, ${competitions.reduce(
                  (n, k) => n + k.competitors.length,
                  0,
                )} entries, ${p.manifest.audio
                  .length} audio file(s) (${megabytes(bytes)}),
                ${f.rubrics.length} rubric(s).
              </p>
              <p class="small">Digest if exported now: <code>${p.manifest
                .digest}</code></p>
              ${!s.frozen
                ? html`
                  <p class="small" style="color:var(--warn)">
                    Registration is not frozen yet: a final export now ends registration for good.
                  </p>
                `
                : ""} ${canExport
                ? html`
                  <div class="row">
                    <form class="inline" method="post" action="/admin/f/${fid}/export">
                      <input type="hidden" name="kind" value="dry">
                      <button class="secondary">Export a dry-run bundle</button>
                    </form>
                    <form
                      class="inline row"
                      method="post"
                      action="/admin/f/${fid}/export"
                      data-confirm="Export the FINAL bundle? After this nothing in the festival can change."
                    >
                      <input type="hidden" name="kind" value="final">
                      ${p.problems.length
                        ? html`
                          <label style="flex-direction:row;align-items:center;gap:6px;color:var(--bad)">
                            <input type="checkbox" name="accept_problems" value="1" required>
                            Export anyway, without the ${p.problems
                              .length} problem file(s)</label>
                        `
                        : ""}
                      <button>Export the final bundle</button>
                    </form>
                  </div>
                `
                : ""}
            </div>
          `
          : ""}
        <h2>Exports</h2>
        ${exports.length === 0
          ? html`
            <p class="muted">None yet.</p>
          `
          : ""}
        <div class="card tablewrap">
          <table>
            <tr>
              <th>#</th>
              <th>Kind</th>
              <th>Generated</th>
              <th>Digest</th>
              <th>Problems</th>
              <th>By</th>
              <th>Download</th>
            </tr>
            ${exports.map((x) =>
              html`
                <tr>
                  <td>${x.id}</td>
                  <td>${x.final
                    ? html`
                      <strong>final</strong>
                    `
                    : "dry run"}</td>
                  <td class="small">${time(x.generated_at)}</td>
                  <td><code>${x.digest.slice(0, 16)}…</code></td>
                  <td>${x.problem_count || ""}</td>
                  <td class="small">${x.email ?? ""}</td>
                  <td class="small">
                    <a href="/admin/exports/${x.id}/bundle.zip">zip</a> ·
                    <a href="/admin/exports/${x
                      .id}/data-only.zip">data only</a> ·
                    <a href="/admin/exports/${x
                      .id}/manifest.json">manifest</a> ·
                    <a href="/admin/exports/${x.id}/data.json">data</a>
                  </td>
                </tr>
              `
            )}
          </table>
        </div>
        <div class="card small">
          <h3 style="margin-top:0">Getting the bundle to the venue</h3>
          <p>
            Copy the zip (or its folder) on a USB stick, or with
            <code>rsync -a --ignore-existing audio/ venue:/srv/sse/audio/</code>. The
            competition server verifies every file against the manifest, so any copy
            method is safe. A <em>data only</em> zip is enough when the venue already
            holds every audio file. The competition server can also pull it over HTTPS
            from
            <code>${ctx.config.baseUrl}/api/bundle</code> with the venue token.
          </p>
        </div>
      `,
    );
  });

  app.post("/admin/f/:fid/export", async (c) => {
    const user = needAdmin(c);
    const fid = id(c, "fid");
    const f = await form(c);
    const final = str(f, "kind") === "final";
    try {
      const r = await exportFestival(ctx, fid, {
        final,
        userId: user.id,
        acceptProblems: f.accept_problems === "1",
      });
      return back(c, `/admin/f/${fid}/export`, {
        ok:
          `${final ? "Final" : "Dry-run"} bundle exported: digest ${
            r.digest.slice(0, 16)
          }…` +
          (r.problems.length
            ? ` with ${r.problems.length} problem file(s) left out.`
            : "."),
      });
    } catch (err) {
      if (err instanceof ExportRefused) {
        return back(c, `/admin/f/${fid}/export`, {
          err: `${err.message} ${err.errors.slice(0, 3).join("; ")}`,
        });
      }
      throw err;
    }
  });

  const loadExport = async (exportId: number) => {
    const [x] = await ctx.sql<{
      id: number;
      festival_id: number;
      folder: string;
      data_text: string;
      manifest_text: string;
      generated_at: Date;
    }[]>`SELECT id, festival_id, folder, data_text, manifest_text, generated_at FROM exports WHERE id = ${exportId}`;
    if (!x) throw new UserError("No such export.", 404);
    return x;
  };

  app.on(
    ["GET", "HEAD"],
    "/admin/exports/:id/:file{bundle\\.zip|data-only\\.zip|manifest\\.json|data\\.json}",
    async (c) => {
      const user = needAdmin(c);
      const x = await loadExport(id(c));
      const name = x.folder.split("/").pop()!;
      await logEvent(ctx.sql, {
        festivalId: x.festival_id,
        userId: user.id,
        kind: "export.download",
        detail: `export ${x.id} ${c.req.param("file")}`,
      });
      switch (c.req.param("file")) {
        case "bundle.zip":
          return fileResponse(c.req.raw, `${x.folder}.zip`, {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${name}.zip"`,
          });
        case "data-only.zip":
          return new Response(
            await dataOnlyZip(
              name,
              x.manifest_text,
              x.data_text,
              x.generated_at,
            ),
            {
              headers: {
                "content-type": "application/zip",
                "content-disposition":
                  `attachment; filename="${name}-data-only.zip"`,
              },
            },
          );
        case "manifest.json":
          return c.body(x.manifest_text, 200, {
            "content-type": "application/json",
          });
        default:
          return c.body(x.data_text, 200, {
            "content-type": "application/json",
          });
      }
    },
  );

  // --- results --------------------------------------------------------------------------

  app.get("/admin/f/:fid/results", async (c) => {
    needAdmin(c);
    const fid = id(c, "fid");
    const s = await state(fid);
    const pushes = await ctx.sql<{
      received_at: Date;
      accepted: boolean;
      error: string | null;
      final: boolean;
      bundle_digest: string | null;
      score_count: number | null;
    }[]>`
      SELECT received_at, accepted, error, final, bundle_digest, score_count FROM score_pushes
      WHERE festival_id = ${fid} ORDER BY id DESC LIMIT 15`;
    const applied = pushes.find((p) => p.accepted && !p.error);
    const [x] = applied
      ? await ctx.sql<{ data_text: string }[]>`SELECT data_text FROM exports
          WHERE festival_id = ${fid} AND digest = ${applied.bundle_digest} LIMIT 1`
      : [];
    const scores = await ctx.sql<
      {
        competition_id: number;
        competitor_id: number;
        judge_id: number;
        criteria_id: number;
        score: string;
      }[]
    >`
      SELECT competition_id, competitor_id, judge_id, criteria_id, score FROM scores WHERE festival_id = ${fid}`;
    const skips = await ctx.sql<
      {
        competition_id: number;
        competitor_id: number;
        stage: string;
        reason: string;
      }[]
    >`
      SELECT competition_id, competitor_id, stage, reason FROM skips WHERE festival_id = ${fid}`;
    const data = x ? JSON.parse(x.data_text) : null;

    let results: Html = html`
      <p class="muted">No scores yet.</p>
    `;
    if (data && scores.length) {
      const tally = tallyResults(
        data,
        scores.map((r) => ({ ...r, score: Number(r.score) })),
      );
      const judgeName = new Map<number, string>();
      for (const r of data.festival.rubrics) {
        for (const j of r.judges) judgeName.set(j.id, j.name);
      }
      results = html`
        ${data.festival.tracks.flatMap((
          t: {
            sessions: {
              competitions: {
                id: number;
                name: string;
                competitors: { id: number; name: string }[];
              }[];
            }[];
          },
        ) => t.sessions.flatMap((ses) => ses.competitions)).map(
          (
            k: {
              id: number;
              name: string;
              competitors: { id: number; name: string }[];
            },
          ) => {
            const rows = tally.get(k.id) ?? [];
            const name = new Map(k.competitors.map((p) => [p.id, p.name]));
            const skipped = skips.filter((x) => x.competition_id === k.id);
            return html`
              <div class="card">
                <h3 style="margin-top:0">${k.name}</h3>
                ${rows.length
                  ? html`
                    <table>
                      <tr>
                        <th>Rank</th>
                        <th>Competitor</th>
                        <th>Total (weighted)</th>
                        <th>By judge</th>
                      </tr>
                      ${rows.map((r, i) =>
                        html`
                          <tr>
                            <td>${i + 1}</td>
                            <td>${name.get(r.competitor_id) ??
                              r.competitor_id}</td>
                            <td><strong>${r.total}</strong></td>
                            <td class="small">${[...r.scores].map((
                              [j, byCrit],
                            ) =>
                              html`
                                ${judgeName.get(j) ?? j}: ${[...byCrit.values()]
                                  .join(" / ")}<br>
                              `
                            )}</td>
                          </tr>
                        `
                      )}
                    </table>
                  `
                  : html`
                    <p class="muted small">No scores.</p>
                  `} ${skipped.length
                  ? html`
                    <p class="small muted">Skipped: ${skipped.map((x) =>
                      `${name.get(x.competitor_id) ?? x.competitor_id} (${
                        x.reason || x.stage
                      })`
                    ).join(", ")}</p>
                  `
                  : ""}
              </div>
            `;
          },
        )}
      `;
    }

    return page(
      c,
      `${s.festival.name}: results`,
      html`
        <h1>${s.festival.name}</h1>${tabs(fid, "results")}
        <div class="card">
          <p>
            Last scores received: ${applied ? time(applied.received_at) : html`
              <span class="muted">never</span>
            `} ${pushes.some((p) => p.accepted && p.final)
              ? html`
                · <span class="pill ready">final results received</span>
              `
              : ""}
          </p>
          <details>
            <summary class="small">Recent pushes</summary>
            <table>
              ${pushes.map((p) =>
                html`
                  <tr>
                    <td class="small">${time(p.received_at)}</td>
                    <td>${p.accepted ? (p.error ? "ignored" : "applied") : html`
                      <span style="color:var(--bad)">rejected</span>
                    `}${p.final ? " (final)" : ""}</td>
                    <td class="small">${p.score_count ?? ""} scores</td>
                    <td class="small">${p.error ?? ""}</td>
                  </tr>
                `
              )}
            </table>
          </details>
        </div>
        ${results}
      `,
    );
  });
}

/** Entries whose audio would not be exported: shown loudly before any export. */
function problemsCard(
  fid: number,
  problems: {
    competition_id: number;
    competitor_id: number;
    kind: string;
    reason: string;
  }[],
  entries: {
    id: number;
    competition_id: number;
    competitor_id: number;
    competitor_name: string;
  }[],
): Html {
  if (problems.length === 0) {
    return html`
      <p class="flash ok">Every entry has its music ready.</p>
    `;
  }
  const entryOf = (p: { competition_id: number; competitor_id: number }) =>
    entries.find((e) =>
      e.competition_id === p.competition_id &&
      e.competitor_id === p.competitor_id
    );
  return html`
    <div class="card problems">
      <h2>${problems.length} audio problem(s)</h2>
      <p class="small">
        These files will not be in the bundle. Resolve them before the final export.
      </p>
      <ul>${problems.map((p) => {
        const e = entryOf(p);
        return html`
          <li>
            ${e
              ? html`
                <a href="/admin/f/${fid}/entries#entry-${e.id}">${e
                  .competitor_name}</a>
              `
              : p.competitor_id} (competition ${p.competition_id}): ${p
              .kind} ${p.reason}
          </li>
        `;
      })}</ul>
    </div>
  `;
}
