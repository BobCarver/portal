import { type Context, Hono } from "@hono/hono";
import { getCookie } from "@hono/hono/cookie";
import { csrf } from "@hono/hono/csrf";
import { HTTPException } from "@hono/hono/http-exception";
import { type User, userForSession } from "./auth.ts";
import type { AppContext } from "./context.ts";
import { UserError } from "./errors.ts";
import { adminRoutes } from "./routes/admin.ts";
import { apiRoutes } from "./routes/api.ts";
import { authRoutes } from "./routes/auth.ts";
import { planRoutes } from "./routes/plan.ts";
import { competitorRoutes } from "./routes/competitor.ts";
import { type Html, html } from "./views/html.ts";
import { layout } from "./views/layout.ts";

export type AppEnv = { Variables: { user: User | null } };
export type C = Context<AppEnv>;

export const SESSION_COOKIE = "portal_session";

/** Thrown by `needUser`: the browser is sent to the sign-in page. */
class LoginRequired extends Error {}

export function needUser(c: C): User {
  const user = c.get("user");
  if (!user) throw new LoginRequired();
  return user;
}

export function needAdmin(c: C): User {
  const user = needUser(c);
  if (!user.is_admin) throw new UserError("Only organisers can do that.", 403);
  return user;
}

/** Render a page (flash messages come from `?ok=` / `?err=`). */
export function page(c: C, title: string, body: Html, status = 200) {
  return c.html(
    layout({
      title,
      body,
      user: c.get("user"),
      ok: c.req.query("ok"),
      err: c.req.query("err"),
    }).value,
    status as 200,
  );
}

/** Redirect after a POST, with a flash message. */
export function back(
  c: C,
  path: string,
  flash?: { ok?: string; err?: string },
) {
  const url = new URL(path, "http://x");
  url.searchParams.delete("ok");
  url.searchParams.delete("err");
  if (flash?.ok) url.searchParams.set("ok", flash.ok);
  if (flash?.err) url.searchParams.set("err", flash.err);
  return c.redirect(url.pathname + url.search + url.hash, 303);
}

export function createApp(ctx: AppContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "same-origin");
    c.header("x-frame-options", "DENY");
  });

  // Forms are protected by the Origin check; the API uses bearer tokens instead.
  app.use("*", (c, next) => {
    if (c.req.path.startsWith("/api/")) return next();
    return csrf()(c, next);
  });

  app.use("*", async (c, next) => {
    c.set(
      "user",
      c.req.path.startsWith("/api/")
        ? null
        : await userForSession(ctx, getCookie(c, SESSION_COOKIE)),
    );
    await next();
  });

  app.onError((e, c) => {
    // Hono's own refusals: a cross-site form (CSRF check), an oversized body.
    if (e instanceof HTTPException) return e.getResponse();
    const err = e.name === "BodyLimitError"
      ? new UserError(
        `The upload is larger than ${
          ctx.config.maxUploadBytes / 1024 / 1024
        } MB.`,
        413,
      )
      : e;
    if (err instanceof LoginRequired) {
      return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`, 303);
    }
    const isApi = c.req.path.startsWith("/api/");
    if (!(err instanceof UserError)) {
      console.error(c.req.method, c.req.path, err);
      return isApi
        ? c.json({ ok: false, error: "internal error" }, 500)
        : c.text("Something went wrong on the server.", 500);
    }
    if (isApi) return c.json({ ok: false, error: err.message }, err.status);
    // A form: back where it came from, with the message.
    const referer = c.req.header("referer");
    if (c.req.method === "POST" && referer) {
      const from = new URL(referer);
      if (from.origin === new URL(c.req.url).origin) {
        return back(c as C, from.pathname + from.search, { err: err.message });
      }
    }
    return c.html(
      layout({
        title: "Error",
        user: c.get("user"),
        err: err.message,
        body: layoutBack(),
      }).value,
      err.status,
    );
  });

  authRoutes(app, ctx);
  competitorRoutes(app, ctx);
  adminRoutes(app, ctx);
  planRoutes(app, ctx);
  apiRoutes(app, ctx);
  app.notFound((c) =>
    c.req.path.startsWith("/api/")
      ? c.json({ ok: false, error: "not found" }, 404)
      : c.html(
        layout({
          title: "Not found",
          user: c.get("user"),
          err: "Page not found.",
          body: layoutBack(),
        }).value,
        404,
      )
  );
  return app;
}

const layoutBack = (): Html =>
  html`
    <p><a href="/">Back to the start</a></p>
  `;
