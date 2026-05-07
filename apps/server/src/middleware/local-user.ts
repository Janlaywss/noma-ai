import { Hono, type MiddlewareHandler } from "hono";
import Database from "better-sqlite3";
import { getDb } from "@/db/index";

export type LocalUserEnv = {
  Variables: {
    userId: string;
    db: Database.Database;
  };
};

export const withLocalUser: MiddlewareHandler<LocalUserEnv> = async (c, next) => {
  c.set("userId", localUserId());
  c.set("db", getDb());
  await next();
};

function localUserId(): string {
  return process.env.NOMA_LOCAL_USER_ID?.trim() || "00000000-0000-0000-0000-000000000000";
}

export function localUserRouter() {
  const r = new Hono<LocalUserEnv>();
  r.use("*", withLocalUser);
  return r;
}
