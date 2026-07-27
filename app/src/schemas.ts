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
  .object({ data: z.array(ThreadSchema), nextCursor: z.string().nullable().optional() })
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

// Two-tier item validation (spec P1-5): a plain `z.union([...knownSchemas,
// unknownSchema])` would silently let a *malformed known-type* item (e.g.
// an agentMessage missing `text`) fall through to the generic unknown-item
// schema, hiding a real protocol mismatch behind a garbled-but-"valid"
// render. So known types are looked up by `type` and validated strictly;
// only a `type` this app has never heard of falls back to the generic
// id/type-only schema.
const UserMessageItemSchema = z
  .object({
    type: z.literal("userMessage"),
    id: z.string(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  })
  .passthrough();

const AgentMessageItemSchema = z
  .object({ type: z.literal("agentMessage"), id: z.string(), text: z.string() })
  .passthrough();

const ReasoningItemSchema = z
  .object({
    type: z.literal("reasoning"),
    id: z.string(),
    summary: z.array(z.string()),
    content: z.array(z.string()),
  })
  .passthrough();

const CommandExecutionItemSchema = z
  .object({
    type: z.literal("commandExecution"),
    id: z.string(),
    command: z.string(),
    cwd: z.string(),
    status: z.string(),
    aggregatedOutput: z.string().nullable(),
    exitCode: z.number().nullable(),
  })
  .passthrough();

const FileChangeItemSchema = z
  .object({
    type: z.literal("fileChange"),
    id: z.string(),
    changes: z.array(z.object({ path: z.string().optional() }).passthrough()),
    status: z.string(),
  })
  .passthrough();

const UnknownThreadItemSchema = z
  .object({ type: z.string(), id: z.string() })
  .passthrough();

const KNOWN_ITEM_SCHEMAS: Record<string, z.ZodType> = {
  userMessage: UserMessageItemSchema,
  agentMessage: AgentMessageItemSchema,
  reasoning: ReasoningItemSchema,
  commandExecution: CommandExecutionItemSchema,
  fileChange: FileChangeItemSchema,
};

const ThreadItemSchema = z.unknown().superRefine((data, ctx) => {
  const type = (data as { type?: unknown } | null)?.type;
  const knownSchema = typeof type === "string" ? KNOWN_ITEM_SCHEMAS[type] : undefined;
  const result = (knownSchema ?? UnknownThreadItemSchema).safeParse(data);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
    }
  }
});

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

export const ModelSchema = z
  .object({
    id: z.string(),
    model: z.string(),
    displayName: z.string(),
    description: z.string(),
    hidden: z.boolean(),
    isDefault: z.boolean(),
  })
  .passthrough();

export const ModelListResponseSchema = z
  .object({ data: z.array(ModelSchema) })
  .passthrough();

const RateLimitWindowSchema = z
  .object({
    usedPercent: z.number(),
    windowDurationMins: z.number().nullable(),
    resetsAt: z.number().nullable(),
  })
  .passthrough();

const AccountCreditsSchema = z
  .object({
    hasCredits: z.boolean(),
    unlimited: z.boolean(),
    balance: z.string().nullable(),
  })
  .passthrough();

const RateLimitSnapshotSchema = z
  .object({
    limitId: z.string().nullable(),
    limitName: z.string().nullable(),
    primary: RateLimitWindowSchema.nullable(),
    secondary: RateLimitWindowSchema.nullable(),
    planType: z.string().nullable(),
    credits: AccountCreditsSchema.nullable().optional(),
  })
  .passthrough();

export const GetAccountRateLimitsResponseSchema = z
  .object({
    rateLimits: RateLimitSnapshotSchema,
    rateLimitsByLimitId: z.record(z.string(), RateLimitSnapshotSchema).nullable(),
  })
  .passthrough();

const TokenUsageBreakdownSchema = z
  .object({
    totalTokens: z.number(),
    inputTokens: z.number(),
    cachedInputTokens: z.number(),
    outputTokens: z.number(),
    reasoningOutputTokens: z.number(),
  })
  .passthrough();

export const ThreadTokenUsageUpdatedSchema = z
  .object({
    threadId: z.string(),
    turnId: z.string(),
    tokenUsage: z
      .object({
        total: TokenUsageBreakdownSchema,
        last: TokenUsageBreakdownSchema,
        modelContextWindow: z.number().nullable(),
      })
      .passthrough(),
  })
  .passthrough();

export const GitDiffToRemoteResponseSchema = z
  .object({ sha: z.string(), diff: z.string() })
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
