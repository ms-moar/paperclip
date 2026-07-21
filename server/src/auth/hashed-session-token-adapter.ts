import crypto from "node:crypto";
import type { DBAdapter, DBAdapterInstance, Where } from "better-auth/types";

type CreateArgs = Parameters<DBAdapter["create"]>[0];
type FindOneArgs = Parameters<DBAdapter["findOne"]>[0];
type FindManyArgs = Parameters<DBAdapter["findMany"]>[0];
type UpdateArgs = Parameters<DBAdapter["update"]>[0];
type UpdateManyArgs = Parameters<DBAdapter["updateMany"]>[0];
type DeleteArgs = Parameters<DBAdapter["delete"]>[0];
type DeleteManyArgs = Parameters<DBAdapter["deleteMany"]>[0];
type CountArgs = Parameters<DBAdapter["count"]>[0];

const SESSION_MODEL = "session";
const TOKEN_FIELD = "token";

function hashToken(t: string): string {
  return crypto.createHash("sha256").update(t, "utf8").digest("hex");
}

function isHashed(v: unknown): v is string {
  return typeof v === "string" && v.length === 64 && /^[0-9a-f]{64}$/.test(v);
}

function tokenCond(where: Where[] | undefined): { idx: number; value: string } | null {
  if (!where || !Array.isArray(where)) return null;
  for (let i = 0; i < where.length; i++) {
    const c = where[i];
    if (!c || c.field !== TOKEN_FIELD) continue;
    const op = (c as { operator?: string }).operator;
    if (op !== undefined && op !== "eq") continue;
    if (typeof c.value !== "string") continue;
    return { idx: i, value: c.value };
  }
  return null;
}

function replaceTokenValue(where: Where[], idx: number, newVal: string): Where[] {
  const out = where.slice();
  out[idx] = { ...out[idx], value: newVal };
  return out;
}

export function withHashedSessionToken(inner: DBAdapterInstance): DBAdapterInstance {
  return (options) => {
    const base = inner(options);
    return wrap(base);
  };
}

function wrap(base: DBAdapter): DBAdapter {
  const wrapped = {
    ...base,

    async create<T extends Record<string, any>, R = T>(args: CreateArgs): Promise<R> {
      if (args.model !== SESSION_MODEL || typeof args.data?.token !== "string") {
        return base.create(args as never) as Promise<R>;
      }
      const plaintext = args.data.token;
      const row = await (base.create({
        ...args,
        data: { ...args.data, token: hashToken(plaintext) },
      } as never) as Promise<R>);
      return row && typeof row === "object"
        ? ({ ...(row as object), token: plaintext } as R)
        : row;
    },

    async findOne<T>(args: FindOneArgs): Promise<T | null> {
      const cond = args.model === SESSION_MODEL ? tokenCond(args.where) : null;
      if (!cond) return base.findOne(args as never) as Promise<T | null>;
      const presented = cond.value;
      const whereHashed = replaceTokenValue(args.where, cond.idx, hashToken(presented));
      const row = await (base.findOne({ ...args, where: whereHashed } as never) as Promise<T | null>);
      if (row) return { ...(row as object), token: presented } as T;
      if (isHashed(presented)) return null;
      return base.findOne(args as never) as Promise<T | null>;
    },

    async findMany<T>(args: FindManyArgs): Promise<T[]> {
      return base.findMany(args as never) as Promise<T[]>;
    },

    async update<T>(args: UpdateArgs): Promise<T | null> {
      const cond = args.model === SESSION_MODEL ? tokenCond(args.where) : null;
      if (!cond) return base.update(args as never) as Promise<T | null>;
      const presented = cond.value;
      // The returned row feeds Better Auth's session-refresh cookie re-set
      // (session.mjs setSessionCookie(updatedSession)). It MUST carry the
      // PLAINTEXT token, else the refreshed cookie is poisoned with the hash
      // and the next request fails to validate. Use the rotated token if the
      // update sets a new one, otherwise the presented plaintext.
      const nextPlaintext =
        typeof args.update?.token === "string" ? args.update.token : presented;
      const whereHashed = replaceTokenValue(args.where, cond.idx, hashToken(presented));
      const updatePayload =
        typeof args.update?.token === "string"
          ? { ...args.update, token: hashToken(args.update.token) }
          : args.update;
      const row = await (base.update({
        ...args,
        where: whereHashed,
        update: updatePayload,
      } as never) as Promise<T | null>);
      if (row) return { ...(row as object), token: nextPlaintext } as T;
      if (isHashed(presented)) return null;
      // dual-read: legacy un-backfilled plaintext row — match by plaintext where,
      // still store a hashed token if one is being set, restore plaintext on return.
      const row2 = await (base.update({
        ...args,
        update: updatePayload,
      } as never) as Promise<T | null>);
      return row2 ? ({ ...(row2 as object), token: nextPlaintext } as T) : null;
    },

    async updateMany(args: UpdateManyArgs): Promise<number> {
      const cond = args.model === SESSION_MODEL ? tokenCond(args.where) : null;
      if (!cond) return base.updateMany(args as never);
      const presented = cond.value;
      const whereHashed = replaceTokenValue(args.where, cond.idx, hashToken(presented));
      const updatePayload =
        typeof args.update?.token === "string"
          ? { ...args.update, token: hashToken(args.update.token) }
          : args.update;
      const n = await base.updateMany({
        ...args,
        where: whereHashed,
        update: updatePayload,
      } as never);
      if (n > 0) return n;
      if (isHashed(presented)) return 0;
      return base.updateMany(args as never);
    },

    async delete(args: DeleteArgs): Promise<void> {
      const cond = args.model === SESSION_MODEL ? tokenCond(args.where) : null;
      if (!cond) return base.delete(args as never);
      const presented = cond.value;
      const whereHashed = replaceTokenValue(args.where, cond.idx, hashToken(presented));
      const n = await base.deleteMany({ model: args.model, where: whereHashed } as never);
      if (n === 0 && !isHashed(presented)) {
        await base.deleteMany({ model: args.model, where: args.where } as never);
      }
    },

    async deleteMany(args: DeleteManyArgs): Promise<number> {
      const cond = args.model === SESSION_MODEL ? tokenCond(args.where) : null;
      if (!cond) return base.deleteMany(args as never);
      const presented = cond.value;
      const whereHashed = replaceTokenValue(args.where, cond.idx, hashToken(presented));
      const n = await base.deleteMany({ model: args.model, where: whereHashed } as never);
      if (n > 0) return n;
      if (isHashed(presented)) return 0;
      return base.deleteMany({ model: args.model, where: args.where } as never);
    },

    async count(args: CountArgs): Promise<number> {
      const isSession = args.model === SESSION_MODEL;
      const cond = isSession ? tokenCond(args.where) : null;
      if (!cond) return base.count(args as never);
      const presented = cond.value;
      const whereHashed = replaceTokenValue(args.where as Where[], cond.idx, hashToken(presented));
      const n = await base.count({ ...args, where: whereHashed } as never);
      if (n > 0) return n;
      if (isHashed(presented)) return 0;
      return base.count({ ...args, where: args.where } as never);
    },

    // Better Auth runs createSession / sign-in writes inside a DB transaction
    // (core/context runWithTransaction → adapter.transaction(trx => als.run({adapter: trx}))).
    // The transaction-scoped `trx` becomes the ambient adapter for every call
    // inside the transaction, so it MUST also be wrapped — otherwise session
    // inserts bypass hashing and land plaintext. Re-wrap the inner trx.
    async transaction(cb: (trx: DBAdapter) => Promise<unknown>): Promise<unknown> {
      if (typeof base.transaction !== "function") return cb(wrapped as DBAdapter);
      return base.transaction((trx: DBAdapter) => cb(trx ? wrap(trx) : (wrapped as DBAdapter)));
    },
  };

  return wrapped as DBAdapter;
}
