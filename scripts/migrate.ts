/** Apply pending migrations (the server also does this at start). */
import { loadConfig } from "../src/config.ts";
import { connect, migrate, redactUrl } from "../src/db.ts";

const config = loadConfig();
const sql = connect(config.databaseUrl, { max: 1 });
const applied = await migrate(sql);
console.log(
  redactUrl(config.databaseUrl),
  applied.length ? `applied: ${applied.join(", ")}` : "up to date",
);
await sql.end();
