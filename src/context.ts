import type { Config } from "./config.ts";
import type { Sql } from "./db.ts";
import type { Mailer } from "./mail.ts";
import type { Storage } from "./storage.ts";

/** What request handlers, the worker and the exporter share. */
export interface AppContext {
  config: Config;
  sql: Sql;
  storage: Storage;
  mailer: Mailer;
  /** Wake the worker (an upload was queued). */
  wakeWorker?: () => void;
  now?: () => Date;
}

export const nowOf = (ctx: AppContext) => ctx.now?.() ?? new Date();
