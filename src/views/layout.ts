import type { User } from "../auth.ts";
import { type Html, html, raw } from "./html.ts";

const CSS = `
:root { --bg:#f7f7f5; --card:#fff; --ink:#1d1d1b; --muted:#6b6b66; --line:#e2e1dc;
  --accent:#2457c5; --ok:#1d7a3a; --warn:#a86200; --bad:#b3261e; --badbg:#fdecea; --warnbg:#fff4e0; --okbg:#e7f5ec; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --card:#1f1f1d; --ink:#ecebe6;
  --muted:#a3a29b; --line:#34332f; --accent:#7ea2ff; --ok:#6fcf8f; --warn:#f0b35a; --bad:#ff8a80;
  --badbg:#3a1d1b; --warnbg:#3a2c14; --okbg:#173022; } }
* { box-sizing: border-box; }
body { margin:0; font:15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--ink); }
header { background:var(--card); border-bottom:1px solid var(--line); padding:10px 16px; display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
header .brand { font-weight:600; margin-right:auto; color:var(--ink); text-decoration:none; }
header form { margin:0; }
main { max-width:1040px; margin:0 auto; padding:16px; }
h1 { font-size:1.5rem; margin:.5rem 0 1rem; } h2 { font-size:1.15rem; margin:1.5rem 0 .5rem; } h3 { font-size:1rem; margin:1rem 0 .4rem; }
a { color:var(--accent); }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:14px 16px; margin:0 0 14px; }
.muted { color:var(--muted); } .small { font-size:.85rem; }
.flash { padding:10px 14px; border-radius:6px; margin:0 0 14px; }
.flash.ok { background:var(--okbg); color:var(--ok); } .flash.err { background:var(--badbg); color:var(--bad); }
.problems { background:var(--badbg); border:1px solid var(--bad); color:var(--ink); }
.problems h2, .problems h3 { color:var(--bad); margin-top:0; }
table { border-collapse:collapse; width:100%; } th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-weight:600; font-size:.85rem; color:var(--muted); }
.tablewrap { overflow-x:auto; }
input, select, textarea, button { font:inherit; color:inherit; }
input[type=text], input[type=email], input[type=password], input[type=number], input[type=datetime-local], select, textarea {
  padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); max-width:100%; }
button, .button { padding:6px 12px; border:1px solid var(--accent); border-radius:6px; background:var(--accent); color:#fff; cursor:pointer; text-decoration:none; display:inline-block; }
button.secondary, .button.secondary { background:transparent; color:var(--accent); }
button.danger { background:transparent; border-color:var(--bad); color:var(--bad); }
button.small { padding:2px 8px; font-size:.85rem; }
form.inline { display:inline; margin:0; }
.row { display:flex; gap:10px; flex-wrap:wrap; align-items:end; margin:0 0 8px; }
.row label { display:flex; flex-direction:column; gap:2px; font-size:.85rem; color:var(--muted); }
.stack label { display:block; margin:0 0 10px; } .stack label > input, .stack label > select { display:block; width:100%; margin-top:2px; }
.pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:.8rem; border:1px solid var(--line); }
.pill.ready { background:var(--okbg); color:var(--ok); border-color:transparent; }
.pill.processing { background:var(--warnbg); color:var(--warn); border-color:transparent; }
.pill.failed, .pill.missing { background:var(--badbg); color:var(--bad); border-color:transparent; }
nav.tabs { display:flex; gap:4px; flex-wrap:wrap; margin:0 0 16px; border-bottom:1px solid var(--line); }
nav.tabs a { padding:6px 12px; text-decoration:none; color:var(--muted); border-bottom:2px solid transparent; }
nav.tabs a.on { color:var(--ink); border-color:var(--accent); }
code, .mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.85em; word-break:break-all; }
audio { width:100%; max-width:420px; height:36px; }
details > summary { cursor:pointer; color:var(--accent); }
`;

/** Turns server-rendered UTC times into the viewer's local time, and fills tz offsets. */
const SCRIPT = `
const pad = (n) => String(n).padStart(2, "0");
for (const el of document.querySelectorAll("time[datetime]")) {
  const d = new Date(el.getAttribute("datetime"));
  if (!isNaN(d)) el.textContent = d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
for (const el of document.querySelectorAll("input[data-utc]")) {
  const d = new Date(el.dataset.utc);
  if (!isNaN(d)) el.value = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
for (const el of document.querySelectorAll("input[name=tz_offset]")) el.value = new Date().getTimezoneOffset();
for (const f of document.querySelectorAll("form[data-confirm]")) {
  f.addEventListener("submit", (e) => { if (!confirm(f.dataset.confirm)) e.preventDefault(); });
}
`;

export interface Page {
  title: string;
  user?: User | null;
  ok?: string | null;
  err?: string | null;
  body: Html;
}

export function layout(p: Page): Html {
  return html`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${p.title} · Registration portal</title>
        <style>
        ${raw(CSS)}
        </style>
      </head>
      <body>
        <header>
          <a class="brand" href="/">Registration portal</a>
          ${p.user
            ? html`
              <a href="/me">My entries</a>
              ${p.user.is_admin
                ? html`
                  <a href="/admin">Admin</a>
                `
                : ""}
              <span class="muted small">${p.user.email}</span>
              <form method="post" action="/logout">
                <button class="secondary small">Sign out</button>
              </form>
            `
            : html`
              <a href="/login">Sign in</a><a href="/register">Register</a>
            `}
        </header>
        <main>
          ${p.ok
            ? html`
              <div class="flash ok">${p.ok}</div>
            `
            : ""} ${p.err
            ? html`
              <div class="flash err">${p.err}</div>
            `
            : ""} ${p.body}
        </main>
        <script type="module">
        ${raw(SCRIPT)}
        </script>
      </body>
    </html>
  `;
}

/** A UTC time, shown in the viewer's local time by the page script. */
export function time(d: Date | string | null | undefined): Html {
  if (!d) {
    return html`
      <span class="muted">-</span>
    `;
  }
  const iso = typeof d === "string" ? d : d.toISOString();
  return html`
    <time datetime="${iso}">${iso.replace("T", " ").replace(
      /:\d\d(\.\d+)?Z$/,
      " UTC",
    )}</time>
  `;
}

export function statusPill(status: string, title?: string | null): Html {
  return html`
    <span class="pill ${status}" title="${title ?? ""}">${status}</span>
  `;
}

/** A POST button (its own small form). */
export function postButton(
  action: string,
  label: string,
  opts: {
    cls?: string;
    confirm?: string;
    fields?: Record<string, string | number>;
  } = {},
): Html {
  return html`
    <form class="inline" method="post" action="${action}" ${opts.confirm
      ? html`
        data-confirm="${opts.confirm}"
      `
      : ""}>
      ${Object.entries(opts.fields ?? {}).map(([k, v]) =>
        html`
          <input type="hidden" name="${k}" value="${v}">
        `
      )}
      <button class="${opts.cls ?? "secondary small"}">${label}</button>
    </form>
  `;
}

export function seconds(n: number): string {
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

export function megabytes(n: number | null | undefined): string {
  return n ? `${(n / 1024 / 1024).toFixed(1)} MB` : "-";
}
