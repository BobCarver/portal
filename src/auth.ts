import type { AppContext } from "./context.ts";
import {
  hashPassword,
  randomToken,
  sha256Hex,
  verifyPassword,
} from "./crypto.ts";
import { UserError } from "./errors.ts";

/**
 * The portal's own accounts (portal.md section 2): email + password, or a
 * magic link, with password reset. Only hashes are stored: of passwords, of
 * session cookies and of one-time links.
 */

export interface User {
  id: number;
  email: string;
  name: string;
  is_admin: boolean;
}

export const SESSION_DAYS = 30;
const LINK_MINUTES = 30;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function checkPasswordRules(password: string): void {
  if (password.length < 10) {
    throw new UserError("Use a password of at least 10 characters.", 422);
  }
}

export async function register(
  ctx: AppContext,
  input: { email: string; name: string; password: string },
): Promise<User> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!EMAIL.test(email)) {
    throw new UserError("Enter a valid email address.", 422);
  }
  if (!name) throw new UserError("Enter your name.", 422);
  checkPasswordRules(input.password);
  const hash = await hashPassword(input.password);
  try {
    const [user] = await ctx.sql<User[]>`
      INSERT INTO users (email, name, password_hash) VALUES (${email}, ${name}, ${hash})
      RETURNING id, email, name, is_admin`;
    return user;
  } catch (err) {
    if (String((err as Error).message).includes("users_email_key")) {
      throw new UserError(
        "An account with this email already exists. Sign in instead.",
        409,
      );
    }
    throw err;
  }
}

export async function login(
  ctx: AppContext,
  email: string,
  password: string,
): Promise<User> {
  const [row] = await ctx.sql<(User & { password_hash: string | null })[]>`
    SELECT id, email, name, is_admin, password_hash FROM users
    WHERE lower(email) = ${email.trim().toLowerCase()}`;
  // Same work whether or not the account exists.
  const ok = row?.password_hash
    ? await verifyPassword(password, row.password_hash)
    : (await verifyPassword(password, await (dummyHash ??= hashPassword("x"))),
      false);
  if (!row || !ok) throw new UserError("Wrong email or password.", 403);
  const { password_hash: _, ...user } = row;
  return user;
}
let dummyHash: Promise<string> | undefined;

/** Start a browser session; returns the cookie value. */
export async function createSession(
  ctx: AppContext,
  userId: number,
): Promise<string> {
  const token = randomToken();
  await ctx.sql`INSERT INTO auth_sessions (token_hash, user_id, expires_at)
    VALUES (${await sha256Hex(token)}, ${userId},
      now() + ${`${SESSION_DAYS} days`}::interval)`;
  return token;
}

export async function userForSession(
  ctx: AppContext,
  token: string | undefined,
): Promise<User | null> {
  if (!token) return null;
  const [user] = await ctx.sql<User[]>`
    SELECT u.id, u.email, u.name, u.is_admin FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${await sha256Hex(token)} AND s.expires_at > now()`;
  return user ?? null;
}

export async function endSession(
  ctx: AppContext,
  token: string | undefined,
): Promise<void> {
  if (token) {
    await ctx
      .sql`DELETE FROM auth_sessions WHERE token_hash = ${await sha256Hex(
        token,
      )}`;
  }
}

/**
 * Email a one-time link (magic sign-in or password reset). Says nothing about
 * whether the account exists.
 */
export async function sendLink(
  ctx: AppContext,
  email: string,
  purpose: "magic" | "reset",
): Promise<void> {
  const [user] = await ctx.sql<{ id: number; email: string }[]>`
    SELECT id, email FROM users WHERE lower(email) = ${email.trim().toLowerCase()}`;
  if (!user) return;
  const token = randomToken();
  await ctx
    .sql`INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at)
    VALUES (${await sha256Hex(token)}, ${user.id}, ${purpose},
      now() + ${`${LINK_MINUTES} minutes`}::interval)`;
  const url = `${ctx.config.baseUrl}/${
    purpose === "magic" ? "magic" : "reset"
  }/${token}`;
  await ctx.mailer.send({
    to: user.email,
    subject: purpose === "magic" ? "Your sign-in link" : "Reset your password",
    text: purpose === "magic"
      ? `Sign in to the registration portal:\n${url}\n\nThe link works once, for ${LINK_MINUTES} minutes.`
      : `Choose a new password:\n${url}\n\nThe link works once, for ${LINK_MINUTES} minutes. ` +
        "If you did not ask for this, ignore this email.",
  });
}

/** The user a valid one-time link belongs to, or null. Marks it used. */
export async function useLink(
  ctx: AppContext,
  token: string,
  purpose: "magic" | "reset",
): Promise<number | null> {
  const [row] = await ctx.sql<{ user_id: number }[]>`
    UPDATE auth_tokens SET used_at = now()
    WHERE token_hash = ${await sha256Hex(token)} AND purpose = ${purpose}
      AND used_at IS NULL AND expires_at > now()
    RETURNING user_id`;
  return row?.user_id ?? null;
}

/** Is the reset link still usable (shown before the form is submitted)? */
export async function linkValid(
  ctx: AppContext,
  token: string,
  purpose: "magic" | "reset",
) {
  const [row] = await ctx.sql`SELECT 1 FROM auth_tokens
    WHERE token_hash = ${await sha256Hex(token)} AND purpose = ${purpose}
      AND used_at IS NULL AND expires_at > now()`;
  return !!row;
}

export async function setPassword(
  ctx: AppContext,
  userId: number,
  password: string,
) {
  checkPasswordRules(password);
  const hash = await hashPassword(password);
  await ctx.sql.begin(async (tx) => {
    await tx`UPDATE users SET password_hash = ${hash} WHERE id = ${userId}`;
    // A reset signs out every other browser.
    await tx`DELETE FROM auth_sessions WHERE user_id = ${userId}`;
  });
}

/** Per-key fixed-window rate limit (in memory: single instance). */
export class RateLimiter {
  private hits = new Map<string, { n: number; until: number }>();
  constructor(private limit: number, private windowMs: number) {}
  check(key: string, now = Date.now()): void {
    const h = this.hits.get(key);
    if (!h || h.until <= now) {
      this.hits.set(key, { n: 1, until: now + this.windowMs });
      if (this.hits.size > 10_000) this.prune(now);
      return;
    }
    if (++h.n > this.limit) {
      throw new UserError(
        "Too many attempts. Wait a few minutes and try again.",
        429,
      );
    }
  }
  private prune(now: number) {
    for (const [k, h] of this.hits) if (h.until <= now) this.hits.delete(k);
  }
}
