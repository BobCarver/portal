import type { Hono } from "@hono/hono";
import { bodyLimit } from "@hono/hono/body-limit";
import type { AudioKind } from "festival-bundle";
import { type AppEnv, back, needUser, page } from "../app.ts";
import {
  acceptUpload,
  AUDIO_KIND_LABEL,
  type AudioFileRow,
} from "../audio/audio.ts";
import { RateLimiter } from "../auth.ts";
import { type AppContext, nowOf } from "../context.ts";
import {
  addMember,
  assertCanEdit,
  assertMember,
  COMPETITOR_TYPES,
  createCompetitor,
  enter,
  entryForUser,
  removeMember,
  updateCompetitor,
  withdraw,
} from "../entries.ts";
import { checkerFor } from "../categories.ts";
import { UserError } from "../errors.ts";
import {
  type CompetitionGender,
  type CompetitionLevel,
  rulesLabel,
} from "../eligibility.ts";
import { festivalState } from "../festival.ts";
import { int, rangeResponse, str } from "../http.ts";
import {
  type Profile,
  profileComplete,
  profileOf,
  updateProfile,
} from "../profile.ts";
import { type Html, html } from "../views/html.ts";
import {
  megabytes,
  postButton,
  seconds,
  statusPill,
  time,
} from "../views/layout.ts";

const uploads = new RateLimiter(30, 60 * 60_000);

export function audioKind(k: string): AudioKind {
  if (k !== "music" && k !== "announce") {
    throw new UserError("Unknown audio kind.", 404);
  }
  return k;
}

/** The upload form and status of one kind of audio for an entry. */
export function audioBlock(
  kind: AudioKind,
  file: AudioFileRow | undefined,
  opts: { canUpload: boolean; uploadAction: string; maxMb: number },
): Html {
  const status = file
    ? html`
      ${statusPill(file.status)} ${file.status === "failed"
        ? html`
          <span class="small">${file.reason}</span>
        `
        : ""} ${file.status === "ready"
        ? html`
          <span class="small muted">
            ${file.lufs ?? "-"} LUFS, peak ${file.true_peak_db ??
              "-"} dBTP, ${megabytes(file.bytes)}</span>
          ${file.flag
            ? html`
              <div class="small" style="color:var(--warn)">⚠ ${file.flag}</div>
            `
            : ""}
          <div><audio controls preload="none" src="/audio/${file
            .id}/play"></audio></div>
        `
        : ""}
      <div class="small muted">Uploaded ${file.original_name} (${megabytes(
        file.original_bytes,
      )}) ${time(file.uploaded_at)}</div>
    `
    : kind === "music"
    ? statusPill("missing")
    : html`
      <span class="muted small">None (optional)</span>
    `;
  return html`
    <div class="card" data-audio="${kind}" data-status="${file?.status ??
      "none"}">
      <h3>${AUDIO_KIND_LABEL[kind]}</h3>
      ${status} ${opts.canUpload
        ? html`
          <form
            class="row"
            method="post"
            action="${opts.uploadAction}"
            enctype="multipart/form-data"
            style="margin-top:8px"
          >
            <input
              type="file"
              name="file"
              accept=".mp3, .wav, audio/mpeg, audio/wav"
              required
            >
            <button class="small">${file ? "Replace" : "Upload"}</button>
            <span class="small muted">mp3 or wav, up to ${opts.maxMb} MB</span>
          </form>
        `
        : ""}
    </div>
  `;
}

/** Shown while a person's profile is incomplete: they cannot enter until it is done. */
const profileNotice = (p: Profile) =>
  profileComplete(p) ? "" : html`
    <p class="flash err">
      Complete <a href="/profile">your profile</a> (gender, date of birth, amateur
      or professional): you cannot enter until it is done.
    </p>
  `;

export function competitorRoutes(app: Hono<AppEnv>, ctx: AppContext) {
  const maxMb = ctx.config.maxUploadBytes / 1024 / 1024;

  // --- dashboard -----------------------------------------------------------------

  // --- profile (gender, date of birth, level) -------------------------------------

  app.get("/profile", async (c) => {
    const user = needUser(c);
    const p = await profileOf(ctx, user.id);
    return page(
      c,
      "Your profile",
      html`
        <h1>Your profile</h1>
        <p class="small muted">
          Competitions take men, women, mixed or same-gender couples, and an age band
          and a level. These details decide which competitions you can enter. They are
          never shared outside the organisers.
        </p>
        <form
          class="card stack"
          method="post"
          action="/profile"
          style="max-width:420px"
        >
          <label>Gender
            <select name="gender" required>
              <option value="">Choose</option>
              <option value="female" ${p.gender === "female"
                ? "selected"
                : ""}>Female</option>
              <option value="male" ${p.gender === "male"
                ? "selected"
                : ""}>Male</option>
            </select>
          </label>
          <label>Date of birth
            <input type="date" name="date_of_birth" required value="${p
              .date_of_birth ?? ""}">
          </label>
          <label>Level
            <select name="level" required>
              <option value="">Choose</option>
              <option value="amateur" ${p.level === "amateur"
                ? "selected"
                : ""}>Amateur</option>
              <option value="professional" ${p.level === "professional"
                ? "selected"
                : ""}>Professional</option>
            </select>
          </label>
          <button>Save profile</button>
        </form>
        <p class="small muted">
          Changing these after you have entered a competition re-checks every entry.
        </p>
      `,
    );
  });

  app.post("/profile", async (c) => {
    const user = needUser(c);
    const f = await c.req.parseBody();
    await updateProfile(ctx, user, {
      gender: str(f, "gender"),
      date_of_birth: str(f, "date_of_birth"),
      level: str(f, "level"),
    });
    return back(c, "/me", { ok: "Profile saved." });
  });

  app.get("/me", async (c) => {
    const user = needUser(c);
    const myProfile = await profileOf(ctx, user.id);
    const competitors = await ctx.sql<
      { id: number; name: string; type: string }[]
    >`
      SELECT p.id, p.name, p.type FROM competitors p
      JOIN competitor_members m ON m.competitor_id = p.id
      WHERE m.user_id = ${user.id} ORDER BY p.name`;
    const entries = await ctx.sql<{
      id: number;
      competitor_id: number;
      competition_name: string;
      festival_name: string;
      duration: number;
      order_number: number;
      order_published: boolean;
      music: string | null;
    }[]>`
      SELECT e.id, e.competitor_id, c.name AS competition_name, f.name AS festival_name,
        e.duration, e.order_number, f.order_published,
        (SELECT status FROM audio_files a WHERE a.entry_id = e.id AND a.kind = 'music') AS music
      FROM entries e JOIN competitions c ON c.id = e.competition_id
        JOIN festivals f ON f.id = c.festival_id
        LEFT JOIN sessions s ON s.id = c.session_id
        JOIN competitor_members m ON m.competitor_id = e.competitor_id
      WHERE m.user_id = ${user.id}
      ORDER BY f.id, s.start_time NULLS LAST, c.order_number, c.name`;
    const festivals = await ctx.sql<
      { id: number; name: string; freeze_at: Date | null }[]
    >`
      SELECT id, name, freeze_at FROM festivals f
      WHERE registration_open AND (freeze_at IS NULL OR freeze_at > now())
        AND NOT EXISTS (SELECT 1 FROM exports x WHERE x.festival_id = f.id AND x.final)
      ORDER BY id`;

    return page(
      c,
      "My entries",
      html`
        <h1>My entries</h1>
        ${profileNotice(myProfile)} ${festivals.length
          ? html`
            <div class="card">
              <h2 style="margin-top:0">Open for registration</h2>
              ${festivals.map((f) =>
                html`
                  <p>
                    <strong>${f.name}</strong>
                    ${f.freeze_at
                      ? html`
                        <span class="small muted">closes ${time(
                          f.freeze_at,
                        )}</span>
                      `
                      : ""} ${competitors.length
                      ? html`
                        <a class="button small" href="/festivals/${f.id}/enter"
                        >Enter a competition</a>
                      `
                      : ""}
                  </p>
                `
              )}
            </div>
          `
          : html`
            <p class="muted">No festival is open for registration right now.</p>
          `}
        <h2>Competitors</h2>
        ${competitors.length === 0
          ? html`
            <p>To enter, first create a competitor: yourself, your couple or your team.</p>
          `
          : ""} ${competitors.map((p) => {
            const mine = entries.filter((e) => e.competitor_id === p.id);
            return html`
              <div class="card">
                <h3 style="margin-top:0">
                  <a href="/competitors/${p.id}">${p.name}</a>
                  <span class="small muted">${p.type}</span>
                </h3>
                ${mine.length
                  ? html`
                    <div class="tablewrap">
                      <table>
                        <tr>
                          <th>Festival</th>
                          <th>Competition</th>
                          <th>Length</th>
                          <th>Music</th>
                          <th>Position</th>
                          <th></th>
                        </tr>
                        ${mine.map((e) =>
                          html`
                            <tr>
                              <td>${e.festival_name}</td>
                              <td>${e.competition_name}</td>
                              <td>${e.duration > 0
                                ? seconds(e.duration)
                                : "–"}</td>
                              <td>${statusPill(e.music ?? "missing")}</td>
                              <td>${e.order_published ? e.order_number : html`
                                <span class="muted">not published</span>
                              `}</td>
                              <td><a href="/entries/${e.id}">Open</a></td>
                            </tr>
                          `
                        )}
                      </table>
                    </div>
                  `
                  : html`
                    <p class="muted small">No entries yet.</p>
                  `}
              </div>
            `;
          })}
        <p><a class="button secondary" href="/competitors/new">New competitor</a></p>
      `,
    );
  });

  // --- competitors ---------------------------------------------------------------

  const typeSelect = (current?: string) =>
    html`
      <select name="type">${COMPETITOR_TYPES.map((t) =>
        html`
          <option value="${t}" ${t === current ? "selected" : ""}>${t}</option>
        `
      )}</select>
    `;

  app.get("/competitors/new", (c) => {
    needUser(c);
    return page(
      c,
      "New competitor",
      html`
        <h1>New competitor</h1>
        <form
          class="card stack"
          method="post"
          action="/competitors"
          style="max-width:420px"
        >
          <label>Display name (as announced, for example "Sam and Kim")
            <input type="text" name="name" required maxlength="120"></label>
          <label>Type ${typeSelect()}</label>
          <button>Create</button>
        </form>
      `,
    );
  });

  app.post("/competitors", async (c) => {
    const user = needUser(c);
    const f = await c.req.parseBody();
    const id = await createCompetitor(ctx, user, {
      name: str(f, "name"),
      type: str(f, "type"),
    });
    return back(c, `/competitors/${id}`, {
      ok:
        "Competitor created. Add the other members' accounts if they have one.",
    });
  });

  app.get("/competitors/:id", async (c) => {
    const user = needUser(c);
    const id = Number(c.req.param("id"));
    await assertMember(ctx.sql, user, id);
    const [p] = await ctx.sql<{ id: number; name: string; type: string }[]>`
      SELECT id, name, type FROM competitors WHERE id = ${id}`;
    const members = await ctx.sql<
      { id: number; name: string; email: string }[]
    >`
      SELECT u.id, u.name, u.email FROM competitor_members m JOIN users u ON u.id = m.user_id
      WHERE m.competitor_id = ${id} ORDER BY u.name`;
    return page(
      c,
      p.name,
      html`
        <h1>${p.name}</h1>
        <form class="card row" method="post" action="/competitors/${id}">
          <label>Display name <input
              type="text"
              name="name"
              value="${p.name}"
              required
              maxlength="120"
            ></label>
          <label>Type ${typeSelect(p.type)}</label>
          <button>Save</button>
        </form>
        <div class="card">
          <h2 style="margin-top:0">Members</h2>
          <p class="small muted">
            Members can manage this competitor's entries and music. They need an
            account.
          </p>
          <table>${members.map((m) =>
            html`
              <tr>
                <td>${m.name}</td>
                <td>${m.email}</td>
                <td>${members.length > 1
                  ? postButton(
                    `/competitors/${id}/members/${m.id}/remove`,
                    "Remove",
                    { cls: "danger small" },
                  )
                  : ""}</td>
              </tr>
            `
          )}</table>
          <form
            class="row"
            method="post"
            action="/competitors/${id}/members"
            style="margin-top:10px"
          >
            <label>Add a member by email <input
                type="email"
                name="email"
                required
              ></label>
            <button class="small">Add</button>
          </form>
        </div>
        <p><a href="/me">Back to my entries</a></p>
      `,
    );
  });

  app.post("/competitors/:id", async (c) => {
    const user = needUser(c);
    const id = Number(c.req.param("id"));
    const f = await c.req.parseBody();
    await updateCompetitor(ctx, user, id, {
      name: str(f, "name"),
      type: str(f, "type"),
    });
    return back(c, `/competitors/${id}`, { ok: "Saved." });
  });

  app.post("/competitors/:id/members", async (c) => {
    const user = needUser(c);
    const id = Number(c.req.param("id"));
    await addMember(ctx, user, id, str(await c.req.parseBody(), "email"));
    return back(c, `/competitors/${id}`, { ok: "Member added." });
  });

  app.post("/competitors/:id/members/:uid/remove", async (c) => {
    const user = needUser(c);
    const id = Number(c.req.param("id"));
    await removeMember(ctx, user, id, Number(c.req.param("uid")));
    return back(
      c,
      Number(c.req.param("uid")) === user.id ? "/me" : `/competitors/${id}`,
      { ok: "Member removed." },
    );
  });

  // --- entering --------------------------------------------------------------------

  app.get("/festivals/:fid/enter", async (c) => {
    const user = needUser(c);
    const fid = Number(c.req.param("fid"));
    const state = await festivalState(ctx.sql, fid, nowOf(ctx));
    if (!state.canEnter) {
      throw new UserError("This festival is not open for registration.", 409);
    }
    const competitors = await ctx.sql<{ id: number; name: string }[]>`
      SELECT p.id, p.name FROM competitors p JOIN competitor_members m ON m.competitor_id = p.id
      WHERE m.user_id = ${user.id} ORDER BY p.name`;
    const all = await ctx.sql<{
      id: number;
      name: string;
      session_name: string | null;
      track_name: string | null;
      location: string | null;
      gender: CompetitionGender;
      level: CompetitionLevel;
      min_age: number | null;
      max_age: number | null;
    }[]>`
      SELECT c.id, c.name, s.name AS session_name, t.name AS track_name, t.location,
        c.gender, c.level, c.min_age, c.max_age
      FROM competitions c LEFT JOIN sessions s ON s.id = c.session_id
        LEFT JOIN tracks t ON t.id = s.track_id
      WHERE c.festival_id = ${fid} AND c.open
      ORDER BY s.start_time NULLS LAST, t.id, s.order_number, c.order_number, c.name`;
    // Only the user's own competitors can be chosen; their members are loaded once.
    const chosen = competitors.find((p) =>
      p.id === Number(c.req.query("competitor"))
    )?.id ??
      competitors[0]?.id;
    const check = chosen ? await checkerFor(ctx.sql, chosen) : null;
    const competitions = all.filter((x) =>
      check?.(x, state.festival.age_on).length === 0
    );
    const hidden = all.length - competitions.length;
    const profile = await profileOf(ctx, user.id);
    return page(
      c,
      `Enter ${state.festival.name}`,
      html`
        <h1>Enter ${state.festival.name}</h1>
        ${profileNotice(profile)} ${competitors.length === 0
          ? html`
            <p>First <a href="/competitors/new">create a competitor</a>.</p>
          `
          : html`
            <form
              class="card stack"
              method="post"
              action="/entries"
              style="max-width:560px"
            >
              <label>Competitor <select name="competitor_id">${competitors.map((
                p,
              ) =>
                html`
                  <option value="${p.id}" ${p.id === chosen
                    ? "selected"
                    : ""}>${p.name}</option>
                `
              )}</select></label>
              <label>Competition <select name="competition_id" required>
                  ${competitions.map((x) =>
                    html`
                      <option value="${x.id}">
                        ${x.name} · ${rulesLabel(x)}${x.session_name
                          ? ` · ${x.session_name}, ${x.track_name}${
                            x.location ? ` (${x.location})` : ""
                          }`
                          : " · not scheduled yet"}
                      </option>
                    `
                  )}
                </select></label>
              ${competitions.length === 0
                ? html`
                  <p class="small muted">There is nothing this competitor can enter right now.</p>
                `
                : ""} ${hidden > 0
                ? html`
                  <p class="small muted">
                    ${hidden} competition(s) are not shown: this competitor's gender, age or
                    level does not match.
                  </p>
                `
                : ""}
              <p class="small muted">
                The entry's length is taken from the music you upload.
              </p>
              <button>Enter</button>
            </form>
          `}
        <script type="module">
        // The offered competitions depend on the competitor: reload for the new one.
        const select = document.querySelector("select[name=competitor_id]");
        select?.addEventListener("change", () => {
          location.search = "?competitor=" + select.value;
        });
        </script>
        <p><a href="/me">Back to my entries</a></p>
      `,
    );
  });

  app.post("/entries", async (c) => {
    const user = needUser(c);
    const f = await c.req.parseBody();
    const id = await enter(ctx, user, {
      competitorId: int(f, "competitor_id"),
      competitionId: int(f, "competition_id"),
    });
    return back(c, `/entries/${id}`, { ok: "Entered. Now upload your music." });
  });

  // --- an entry --------------------------------------------------------------------

  app.get("/entries/:id", async (c) => {
    const user = needUser(c);
    const { entry, state, canEdit } = await entryForUser(
      ctx,
      user,
      Number(c.req.param("id")),
    );
    const files = await ctx.sql<AudioFileRow[]>`
      SELECT * FROM audio_files WHERE entry_id = ${entry.id}`;
    const byKind = new Map(files.map((f) => [f.kind, f]));
    const processing = files.some((f) => f.status === "processing");
    return page(
      c,
      entry.competition_name,
      html`
        <h1>${entry.competitor_name} · ${entry.competition_name}</h1>
        <div class="card">
          <p>
            ${entry.festival_name} · ${entry.session_name
              ? html`
                ${entry.track_name} · ${entry.session_name}, planned ${time(
                  entry.start_time,
                )}
              `
              : html`
                <span class="muted"
                >not scheduled yet: the organiser assigns the track and session</span>
              `}
          </p>
          <p>Running position: ${state.festival.order_published || user.is_admin
            ? html`
              <strong>${entry.order_number}</strong>
            `
            : html`
              <span class="muted">published by the organiser before the event</span>
            `}</p>
          <p>Length: ${entry.duration > 0
            ? html`
              ${seconds(
                entry.duration,
              )} <span class="small muted">(from the music)</span>
            `
            : html`
              <span class="muted">set when the music is ready</span>
            `}</p>
          ${!canEdit
            ? html`
              <p class="small muted">${state.final
                ? "The final bundle has been exported; nothing can change now."
                : "Registration is frozen: changes go through the organiser."}</p>
            `
            : ""}
        </div>
        ${(["music", "announce"] as const).map((kind) =>
          audioBlock(kind, byKind.get(kind), {
            canUpload: canEdit,
            uploadAction: `/entries/${entry.id}/audio/${kind}`,
            maxMb,
          })
        )} ${processing
          ? html`
            <p class="small muted" id="processing">
              Normalising the loudness… this page refreshes when it is done.
            </p>
            <script type="module">
            const poll = async () => {
              const r = await fetch("/entries/${entry.id}/status.json");
              if (r.ok && !(await r.json()).processing) location.reload();
              else setTimeout(poll, 2000);
            };
            setTimeout(poll, 2000);
            </script>
          `
          : ""} ${canEdit
          ? html`
            <p>${postButton(
              `/entries/${entry.id}/withdraw`,
              "Withdraw this entry",
              {
                cls: "danger",
                confirm: "Withdraw this entry? Its music is removed too.",
              },
            )}</p>
          `
          : ""}
        <p><a href="/me">Back to my entries</a></p>
      `,
    );
  });

  app.get("/entries/:id/status.json", async (c) => {
    const user = needUser(c);
    const { entry } = await entryForUser(ctx, user, Number(c.req.param("id")));
    const files = await ctx.sql<
      { kind: string; status: string; reason: string | null }[]
    >`
      SELECT kind, status, reason FROM audio_files WHERE entry_id = ${entry.id}`;
    return c.json({
      processing: files.some((f) => f.status === "processing"),
      files,
    });
  });

  app.post("/entries/:id/withdraw", async (c) => {
    const user = needUser(c);
    await withdraw(ctx, user, Number(c.req.param("id")));
    return back(c, "/me", { ok: "Entry withdrawn." });
  });

  app.post(
    "/entries/:id/audio/:kind",
    bodyLimit({
      maxSize: ctx.config.maxUploadBytes + 64 * 1024,
      onError: () => {
        throw new UserError(`The file is larger than ${maxMb} MB.`, 413);
      },
    }),
    async (c) => {
      const user = needUser(c);
      const kind = audioKind(c.req.param("kind"));
      const x = await entryForUser(ctx, user, Number(c.req.param("id")));
      assertCanEdit(x);
      uploads.check(`upload:${user.id}`);
      const file = (await c.req.parseBody()).file;
      if (!(file instanceof File)) {
        throw new UserError("Choose a file to upload.", 422);
      }
      await acceptUpload(ctx, {
        entryId: x.entry.id,
        kind,
        data: new Uint8Array(await file.arrayBuffer()),
        name: file.name,
        userId: user.id,
        festivalId: x.entry.festival_id,
      });
      const to = c.req.query("to") === "admin" && user.is_admin
        ? `/admin/f/${x.entry.festival_id}/entries#entry-${x.entry.id}`
        : `/entries/${x.entry.id}`;
      return back(c, to, {
        ok: `${AUDIO_KIND_LABEL[kind]} uploaded; normalising now.`,
      });
    },
  );

  // --- playback (members and organisers) --------------------------------------------

  app.on(["GET", "HEAD"], "/audio/:id/:which{play|original}", async (c) => {
    const user = needUser(c);
    const [file] = await ctx.sql<(AudioFileRow & { competitor_id: number })[]>`
      SELECT a.*, e.competitor_id FROM audio_files a JOIN entries e ON e.id = a.entry_id
      WHERE a.id = ${Number(c.req.param("id"))}`;
    if (!file) throw new UserError("No such file.", 404);
    await assertMember(ctx.sql, user, file.competitor_id);
    const original = c.req.param("which") === "original";
    const key = original ? file.original_key : file.storage_key;
    if (!key) throw new UserError("This file is not ready yet.", 404);
    const size = await ctx.storage.size(key);
    return rangeResponse(c.req.raw, size, (r) => ctx.storage.read(key, r), {
      "content-type": original
        ? (file.original_format === "wav" ? "audio/wav" : "audio/mpeg")
        : "audio/mpeg",
      "cache-control": "private, max-age=3600",
    });
  });
}
