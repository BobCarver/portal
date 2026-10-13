/**
 * Create an organiser account, or make an existing account an organiser.
 *   deno task admin <email> [name]
 * A new account gets a password reset link printed (no password on the
 * command line).
 */
import { sendLink } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { connect, migrate } from "../src/db.ts";
import { ConsoleMailer } from "../src/mail.ts";
import { DiskStorage } from "../src/storage.ts";

const [email, ...nameParts] = Deno.args;
if (!email || !email.includes("@")) {
  console.error("usage: deno task admin <email> [name]");
  Deno.exit(2);
}
const config = loadConfig();
const sql = connect(config.databaseUrl, { max: 1 });
await migrate(sql);
const [existing] = await sql<{ id: number }[]>`
  SELECT id FROM users WHERE lower(email) = ${email.toLowerCase()}`;
if (existing) {
  await sql`UPDATE users SET is_admin = true WHERE id = ${existing.id}`;
  console.log(`${email} is now an organiser.`);
} else {
  await sql`INSERT INTO users (email, name, is_admin)
    VALUES (${email.toLowerCase()}, ${
    nameParts.join(" ") || email.split("@")[0]
  }, true)`;
  console.log(`Created organiser ${email}. Set a password with this link:`);
  await sendLink(
    {
      config,
      sql,
      storage: new DiskStorage(config.storageDir),
      mailer: new ConsoleMailer(),
    },
    email,
    "reset",
  );
}
await sql.end();
