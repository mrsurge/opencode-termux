export * as SessionLegacyProjection from "./legacy-projection"

import { and, asc, eq, inArray } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import type { ProviderMetadata } from "@opencode-ai/llm"
import type { Database } from "../database/database"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { SessionV1 } from "../v1/session"
import { AgentAttachment, FileAttachment, Source } from "./prompt"
import { SessionMessage } from "./message"
import { MessageTable, PartTable, SessionMessageTable } from "./sql"
import type { SessionSchema } from "./schema"

type DatabaseService = Database.Interface["db"]

const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const LegacySeqBase = -1_000_000_000

export const ensure = Effect.fn("SessionLegacyProjection.ensure")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const legacyRows = yield* db
    .select()
    .from(MessageTable)
    .where(eq(MessageTable.session_id, sessionID))
    .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
    .all()
    .pipe(Effect.orDie)
  if (legacyRows.length === 0) return { legacy: 0, projected: 0 }

  const existingRows = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        inArray(
          SessionMessageTable.id,
          legacyRows.map((row) => SessionMessage.ID.make(row.id)),
        ),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  const existing = new Set(existingRows.map((row) => row.id))
  const missing = legacyRows.filter((row) => !existing.has(SessionMessage.ID.make(row.id)))
  if (missing.length === 0) return { legacy: legacyRows.length, projected: 0 }

  const partRows = yield* db
    .select()
    .from(PartTable)
    .where(
      inArray(
        PartTable.message_id,
        missing.map((row) => row.id),
      ),
    )
    .orderBy(asc(PartTable.message_id), asc(PartTable.id))
    .all()
    .pipe(Effect.orDie)
  const parts = new Map<string, SessionV1.Part[]>()
  for (const row of partRows) {
    const current = parts.get(row.message_id)
    const next = legacyPart(row)
    if (current) current.push(next)
    else parts.set(row.message_id, [next])
  }

  const legacyIndex = new Map(legacyRows.map((row, index) => [row.id, index]))
  const values = missing.flatMap((row) => {
    const message = legacyMessage(row, parts.get(row.id) ?? [])
    if (!message) return []
    const encoded = encodeMessage(message)
    const { id, type, ...data } = encoded
    return [
      {
        id: SessionMessage.ID.make(id),
        session_id: sessionID,
        type,
        seq: LegacySeqBase + (legacyIndex.get(row.id) ?? 0),
        time_created: DateTime.toEpochMillis(message.time.created),
        data,
      },
    ]
  })
  if (values.length === 0) return { legacy: legacyRows.length, projected: 0 }

  for (const chunk of chunks(values, 250)) {
    yield* db.insert(SessionMessageTable).values(chunk).onConflictDoNothing().run().pipe(Effect.orDie)
  }
  return { legacy: legacyRows.length, projected: values.length }
})

function chunks<T>(items: readonly T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, index * size + size),
  )
}

function legacyInfo(row: typeof MessageTable.$inferSelect): SessionV1.Info {
  return {
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
  } as SessionV1.Info
}

function legacyPart(row: typeof PartTable.$inferSelect): SessionV1.Part {
  return {
    ...row.data,
    id: row.id,
    messageID: row.message_id,
    sessionID: row.session_id,
  } as SessionV1.Part
}

function legacyMessage(row: typeof MessageTable.$inferSelect, parts: readonly SessionV1.Part[]) {
  const info = legacyInfo(row)
  if (info.role === "user") return legacyUser(info, parts)
  return legacyAssistant(info, parts)
}

function legacyUser(info: SessionV1.User, parts: readonly SessionV1.Part[]) {
  return new SessionMessage.User({
    id: SessionMessage.ID.make(info.id),
    type: "user",
    text: legacyUserText(parts),
    files: legacyFiles(parts),
    agents: legacyAgents(parts),
    time: { created: DateTime.makeUnsafe(info.time.created) },
  })
}

function legacyUserText(parts: readonly SessionV1.Part[]) {
  const text = parts
    .flatMap((part) => (part.type === "text" && !part.ignored && part.text !== "" ? [part.text] : []))
    .join("\n\n")
  if (text !== "") return text
  if (parts.some((part) => part.type === "compaction")) return "What did we do so far?"
  if (parts.some((part) => part.type === "subtask")) return "The following tool was executed by the user"
  return ""
}

function legacyFiles(parts: readonly SessionV1.Part[]) {
  const files = parts.flatMap((part) => {
    if (part.type !== "file") return []
    return [legacyFile(part)]
  })
  return files.length === 0 ? undefined : files
}

function legacyAgents(parts: readonly SessionV1.Part[]) {
  const agents = parts.flatMap((part) => {
    if (part.type !== "agent") return []
    return [
      new AgentAttachment({
        name: part.name,
        source: part.source
          ? new Source({
              start: part.source.start,
              end: part.source.end,
              text: part.source.value,
            })
          : undefined,
      }),
    ]
  })
  return agents.length === 0 ? undefined : agents
}

function legacySource(source: SessionV1.FilePart["source"] | undefined) {
  if (!source) return undefined
  return new Source({
    start: source.text.start,
    end: source.text.end,
    text: source.text.value,
  })
}

function legacyFile(part: SessionV1.FilePart) {
  return FileAttachment.create({
    uri: part.url,
    mime: part.mime,
    name: part.filename,
    source: legacySource(part.source),
  })
}

function legacyAssistant(info: SessionV1.Assistant, parts: readonly SessionV1.Part[]) {
  return new SessionMessage.Assistant({
    id: SessionMessage.ID.make(info.id),
    type: "assistant",
    agent: info.agent,
    model: {
      id: ModelV2.ID.make(info.modelID),
      providerID: ProviderV2.ID.make(info.providerID),
      ...(info.variant ? { variant: ModelV2.VariantID.make(info.variant) } : {}),
    },
    content: parts.flatMap(legacyAssistantContent),
    snapshot: legacySnapshot(parts),
    finish: info.finish,
    cost: info.cost,
    tokens: info.tokens
      ? {
          input: info.tokens.input,
          output: info.tokens.output,
          reasoning: info.tokens.reasoning,
          cache: {
            read: info.tokens.cache.read,
            write: info.tokens.cache.write,
          },
        }
      : undefined,
    error: legacyError(info.error),
    time: {
      created: DateTime.makeUnsafe(info.time.created),
      ...(info.time.completed ? { completed: DateTime.makeUnsafe(info.time.completed) } : {}),
    },
  })
}

function legacyAssistantContent(part: SessionV1.Part): SessionMessage.AssistantContent[] {
  if (part.type === "text") {
    return [new SessionMessage.AssistantText({ type: "text", id: part.id, text: part.text })]
  }
  if (part.type === "reasoning") {
    return [
      new SessionMessage.AssistantReasoning({
        type: "reasoning",
        id: part.id,
        text: part.text,
        providerMetadata: providerMetadata(part.metadata),
      }),
    ]
  }
  if (part.type === "tool") {
    return [
      new SessionMessage.AssistantTool({
        type: "tool",
        id: part.callID,
        name: part.tool,
        provider: {
          executed: providerExecuted(part.metadata),
          metadata: providerMetadata(part.metadata),
          resultMetadata: providerMetadata(toolStateMetadata(part.state)),
        },
        state: legacyToolState(part.state),
        time: legacyToolTime(part.state),
      }),
    ]
  }
  return []
}

function legacyToolState(state: SessionV1.ToolState): SessionMessage.ToolState {
  if (state.status === "pending") {
    return new SessionMessage.ToolStatePending({ status: "pending", input: state.raw })
  }
  if (state.status === "running") {
    return new SessionMessage.ToolStateRunning({
      status: "running",
      input: state.input,
      structured: structured(state.metadata),
      content: [],
    })
  }
  if (state.status === "completed") {
    return new SessionMessage.ToolStateCompleted({
      status: "completed",
      input: state.input,
      attachments: state.attachments?.map(legacyFile),
      structured: structured(state.metadata),
      content: [{ type: "text", text: state.output }],
      outputPaths: [],
      result: state.output,
    })
  }
  return new SessionMessage.ToolStateError({
    status: "error",
    input: state.input,
    structured: structured(state.metadata),
    content: [],
    error: { type: "unknown", message: state.error },
    result: state.error,
  })
}

function legacyToolTime(state: SessionV1.ToolState) {
  if (state.status === "pending") return { created: DateTime.makeUnsafe(0) }
  if (state.status === "running") return { created: DateTime.makeUnsafe(state.time.start) }
  if (state.status === "completed") {
    return {
      created: DateTime.makeUnsafe(state.time.start),
      completed: DateTime.makeUnsafe(state.time.end),
      ...(state.time.compacted ? { pruned: DateTime.makeUnsafe(state.time.compacted) } : {}),
    }
  }
  return {
    created: DateTime.makeUnsafe(state.time.start),
    completed: DateTime.makeUnsafe(state.time.end),
  }
}

function toolStateMetadata(state: SessionV1.ToolState) {
  if (state.status === "pending") return undefined
  return state.metadata
}

function legacySnapshot(parts: readonly SessionV1.Part[]) {
  const start = parts.find((part): part is SessionV1.StepStartPart => part.type === "step-start")?.snapshot
  const end = parts.findLast((part): part is SessionV1.StepFinishPart => part.type === "step-finish")?.snapshot
  return start || end ? { start, end } : undefined
}

function providerMetadata(value: Record<string, unknown> | undefined): ProviderMetadata | undefined {
  if (!value) return undefined
  const metadata = Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, Record<string, unknown>] => {
      const item = entry[1]
      return item !== null && typeof item === "object" && !Array.isArray(item)
    }),
  )
  return Object.keys(metadata).length === 0 ? undefined : metadata
}

function providerExecuted(value: Record<string, unknown> | undefined) {
  return value?.providerExecuted === true
}

function structured(value: Record<string, unknown> | undefined) {
  if (!value) return {}
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "providerExecuted"))
}

function legacyError(value: SessionV1.Assistant["error"] | undefined) {
  if (!value) return undefined
  if ("data" in value && typeof value.data === "object" && value.data !== null && "message" in value.data) {
    const message = value.data.message
    if (typeof message === "string") return { type: "unknown" as const, message }
  }
  return { type: "unknown" as const, message: value.name }
}
