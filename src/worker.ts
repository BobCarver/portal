/** The normalisation worker as its own process (WORKER=separate on the web side). */
import { startWorker } from "./audio/worker.ts";
import { loadConfig } from "./config.ts";
import { connect, migrate } from "./db.ts";
import { ConsoleMailer } from "./mail.ts";
import { DiskStorage } from "./storage.ts";

const config = loadConfig();
const sql = connect(config.databaseUrl, { max: 2 });
await migrate(sql);
const stop = new AbortController();
const worker = startWorker(
  {
    config,
    sql,
    storage: new DiskStorage(config.storageDir),
    mailer: new ConsoleMailer(),
  },
  stop.signal,
);
console.log("normalisation worker running");
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(sig, () => stop.abort());
}
await worker.done;
await sql.end();
