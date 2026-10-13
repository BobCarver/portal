import { createApp } from "./app.ts";
import { startWorker } from "./audio/worker.ts";
import { loadConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { connect, migrate, redactUrl } from "./db.ts";
import { ConsoleMailer } from "./mail.ts";
import { DiskStorage } from "./storage.ts";

const config = loadConfig();
console.log("database:", redactUrl(config.databaseUrl));
const sql = connect(config.databaseUrl);
const applied = await migrate(sql);
if (applied.length) console.log("migrations applied:", applied.join(", "));

const ctx: AppContext = {
  config,
  sql,
  storage: new DiskStorage(config.storageDir),
  mailer: new ConsoleMailer(),
};
await Deno.mkdir(config.exportDir, { recursive: true });

const stop = new AbortController();
if (config.inlineWorker) {
  const worker = startWorker(ctx, stop.signal);
  ctx.wakeWorker = worker.wake;
  console.log("normalisation worker: inline");
} else {
  console.log("normalisation worker: separate process (deno task worker)");
}

const app = createApp(ctx);
const server = Deno.serve(
  { port: config.port, signal: stop.signal },
  app.fetch,
);
console.log(`portal on ${config.baseUrl}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(sig, () => {
    stop.abort();
    server.finished.then(() => sql.end()).then(() => Deno.exit(0));
  });
}
