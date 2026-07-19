// Runtime boundary validation (spec N-10) for the app-server protocol
// subset this app actually depends on. Compile-time types (types.ts) only
// guarantee the shape of data *we wrote*; anything arriving over the wire
// from app-server needs to be checked at runtime too, since a future Codex
// version could rename/remove a field we rely on without TypeScript ever
// noticing.
//
// Design: `.passthrough()` on every object schema so unknown/new fields
// from a newer Codex version don't fail validation (forward-compatible) --
// only missing or wrong-typed fields we actually read cause a failure.

import { z } from "zod";

export const RequestIdSchema = z.union([z.string(), z.number()]);

export const InitializeResponseSchema = z
  .object({
    userAgent: z.string(),
    codexHome: z.string(),
    platformFamily: z.string(),
    platformOs: z.string(),
    connectionId: z.string().optional(),
  })
  .passthrough();

const ThreadStatusSchema = z
  .object({ type: z.enum(["notLoaded", "idle", "systemError", "active"]) })
  .passthrough();

const TurnSchema = z
  .object({
    id: z.string(),
    status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
    items: z.array(z.unknown()).default([]),
  })
  .passthrough();

export const ThreadSchema = z
  .object({
    id: z.string(),
    preview: z.string(),
    cwd: z.string(),
    status: ThreadStatusSchema,
    name: z.string().nullable(),
    updatedAt: z.number(),
    turns: z.array(TurnSchema).default([]),
  })
  .passthrough();

export const ThreadListResponseSchema = z
  .object({ data: z.array(ThreadSchema) })
  .passthrough();

export const ThreadStartResponseSchema = z
  .object({ thread: ThreadSchema })
  .passthrough();

export const ThreadResumeResponseSchema = z
  .object({ thread: ThreadSchema })
  .passthrough();

export const ThreadReadResponseSchema = z
  .object({ thread: ThreadSchema })
  .passthrough();

export const TurnStartedNotificationSchema = z
  .object({
    threadId: z.string(),
    turn: z.object({ id: z.string() }).passthrough(),
  })
  .passthrough();

export const TurnCompletedNotificationSchema = z
  .object({
    threadId: z.string(),
    turn: TurnSchema,
  })
  .passthrough();

const ThreadItemSchema = z
  .object({ type: z.string(), id: z.string() })
  .passthrough();

export const ItemNotificationSchema = z
  .object({
    threadId: z.string(),
    turnId: z.string(),
    item: ThreadItemSchema,
  })
  .passthrough();

export const AgentMessageDeltaSchema = z
  .object({
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    delta: z.string(),
  })
  .passthrough();

export const ServerRequestSchema = z
  .object({
    id: RequestIdSchema,
    method: z.string(),
    params: z.unknown(),
  })
  .passthrough();

/**
 * Parse `data` with `schema`. On success returns the parsed (and
 * `.passthrough()`-preserved) value. On failure, reports via `onError` and
 * returns null so the caller can bail out of that one message instead of
 * crashing on `undefined` access or showing garbled data.
 */
export function parseOrReport<T>(
  schema: z.ZodType<T>,
  data: unknown,
  label: string,
  onError: (message: string) => void
): T | null {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  onError(`${label}: 受信データがスキーマと一致しません — ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return null;
}
