import type { Hono } from "@hono/hono";
import { deleteCookie, getCookie, setCookie } from "@hono/hono/cookie";
import { type AppEnv, back, type C, page, SESSION_COOKIE } from "../app.ts";
import {
  createSession,
  endSession,
  linkValid,
  login,
  RateLimiter,
  register,
  sendLink,
  SESSION_DAYS,
  setPassword,
  useLink,
} from "../auth.ts";
import type { AppContext } from "../context.ts";
import { UserError } from "../errors.ts";
import { str } from "../http.ts";
import { html } from "../views/html.ts";

const attempts = new RateLimiter(10, 10 * 60_000);
const links = new RateLimiter(5, 15 * 60_000);

/** The client's address: the proxy's X-Forwarded-For only when TRUST_PROXY is set. */
export const clientKey = (c: C, ctx: AppContext) =>
  (ctx.config.trustProxy &&
    c.req.header("x-forwarded-for")?.split(",")[0].trim()) ||
  (c.env as { remoteAddr?: { hostname?: string } } | undefined)?.remoteAddr
    ?.hostname ||
  "local";

/** Only local paths, so `next` cannot send the user to another site. */
const safeNext = (next: string | undefined) =>
  next && next.startsWith("/") && !next.startsWith("//") ? next : "/me";

export function authRoutes(app: Hono<AppEnv>, ctx: AppContext) {
  const signIn = async (c: C, userId: number, next?: string) => {
    const token = await createSession(ctx, userId);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: ctx.config.baseUrl.startsWith("https:"),
      path: "/",
      maxAge: SESSION_DAYS * 86400,
    });
    return c.redirect(safeNext(next), 303);
  };

  app.get("/", (c) => {
    const user = c.get("user");
    if (user) return c.redirect(user.is_admin ? "/admin" : "/me");
    return page(
      c,
      "Welcome",
      html`
        <h1>Registration portal</h1>
        <div class="card">
          <p>Register your competitors, enter competitions and upload your music.</p>
          <p>
            <a class="button" href="/register">Create an account</a>
            <a class="button secondary" href="/login">Sign in</a>
          </p>
        </div>
      `,
    );
  });

  app.get("/register", (c) =>
    page(
      c,
      "Create an account",
      html`
        <h1>Create an account</h1>
        <form
          class="card stack"
          method="post"
          action="/register"
          style="max-width:420px"
        >
          <label>Your name <input
              type="text"
              name="name"
              required
              autocomplete="name"
            ></label>
          <label>Email <input
              type="email"
              name="email"
              required
              autocomplete="email"
            ></label>
          <label>Password (10 characters or more)
            <input
              type="password"
              name="password"
              required
              minlength="10"
              autocomplete="new-password"
            ></label>
          <button>Create account</button>
        </form>
      `,
    ));

  app.post("/register", async (c) => {
    attempts.check(`register:${clientKey(c, ctx)}`);
    const f = await c.req.parseBody();
    const user = await register(ctx, {
      name: str(f, "name"),
      email: str(f, "email"),
      password: typeof f.password === "string" ? f.password : "",
    });
    return signIn(c, user.id);
  });

  app.get("/login", (c) => {
    const next = c.req.query("next") ?? "";
    return page(
      c,
      "Sign in",
      html`
        <h1>Sign in</h1>
        <form class="card stack" method="post" action="/login" style="max-width:420px">
          <input type="hidden" name="next" value="${next}">
          <label>Email <input
              type="email"
              name="email"
              required
              autocomplete="email"
            ></label>
          <label>Password <input
              type="password"
              name="password"
              required
              autocomplete="current-password"
            ></label>
          <button>Sign in</button>
        </form>
        <p class="small">
          <a href="/magic">Email me a sign-in link instead</a> ·
          <a href="/forgot">Forgot your password?</a> · <a href="/register"
          >Create an account</a>
        </p>
      `,
    );
  });

  app.post("/login", async (c) => {
    const f = await c.req.parseBody();
    const email = str(f, "email");
    attempts.check(`login:${clientKey(c, ctx)}`);
    attempts.check(`login:${email.toLowerCase()}`);
    const user = await login(
      ctx,
      email,
      typeof f.password === "string" ? f.password : "",
    );
    return signIn(c, user.id, str(f, "next"));
  });

  app.post("/logout", async (c) => {
    await endSession(ctx, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/", 303);
  });

  // --- one-time links -----------------------------------------------------------

  const emailForm = (action: string, button: string) =>
    html`
      <form
        class="card stack"
        method="post"
        action="${action}"
        style="max-width:420px"
      >
        <label>Email <input
            type="email"
            name="email"
            required
            autocomplete="email"
          ></label>
        <button>${button}</button>
      </form>
    `;

  app.get("/magic", (c) =>
    page(
      c,
      "Sign-in link",
      html`
        <h1>Email me a sign-in link</h1>${emailForm("/magic", "Send link")}
      `,
    ));

  app.get("/forgot", (c) =>
    page(
      c,
      "Reset password",
      html`
        <h1>Reset your password</h1>${emailForm("/forgot", "Send reset link")}
      `,
    ));

  for (
    const [path, purpose] of [["/magic", "magic"], [
      "/forgot",
      "reset",
    ]] as const
  ) {
    app.post(path, async (c) => {
      links.check(`link:${clientKey(c, ctx)}`);
      const email = str(await c.req.parseBody(), "email");
      links.check(`link:${email.toLowerCase()}`);
      await sendLink(ctx, email, purpose);
      return back(c, path, {
        ok:
          "If an account exists for that address, a link is on its way. It works once, for 30 minutes.",
      });
    });
  }

  // The link opens a page with a button, so mail scanners that fetch links do
  // not use it up.
  app.get("/magic/:token", async (c) => {
    const token = c.req.param("token");
    if (!(await linkValid(ctx, token, "magic"))) {
      throw new UserError(
        "This sign-in link has expired or was already used.",
        404,
      );
    }
    return page(
      c,
      "Sign in",
      html`
        <h1>Sign in</h1><form class="card" method="post" action="/magic/${token}">
          <button>Continue</button>
        </form>
      `,
    );
  });

  app.post("/magic/:token", async (c) => {
    const userId = await useLink(ctx, c.req.param("token"), "magic");
    if (!userId) {
      throw new UserError(
        "This sign-in link has expired or was already used.",
        404,
      );
    }
    return signIn(c, userId);
  });

  app.get("/reset/:token", async (c) => {
    const token = c.req.param("token");
    if (!(await linkValid(ctx, token, "reset"))) {
      throw new UserError(
        "This reset link has expired or was already used.",
        404,
      );
    }
    return page(
      c,
      "New password",
      html`
        <h1>Choose a new password</h1>
        <form
          class="card stack"
          method="post"
          action="/reset/${token}"
          style="max-width:420px"
        >
          <label>New password (10 characters or more)
            <input
              type="password"
              name="password"
              required
              minlength="10"
              autocomplete="new-password"
            ></label>
          <button>Save and sign in</button>
        </form>
      `,
    );
  });

  app.post("/reset/:token", async (c) => {
    const f = await c.req.parseBody();
    const password = typeof f.password === "string" ? f.password : "";
    if (password.length < 10) {
      throw new UserError("Use a password of at least 10 characters.", 422);
    }
    const userId = await useLink(ctx, c.req.param("token"), "reset");
    if (!userId) {
      throw new UserError(
        "This reset link has expired or was already used.",
        404,
      );
    }
    await setPassword(ctx, userId, password);
    return signIn(c, userId);
  });
}
