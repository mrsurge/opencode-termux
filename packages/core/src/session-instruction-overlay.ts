export * as SessionInstructionOverlay from "./session-instruction-overlay"

import { Context, Effect, Layer, Ref, Schema } from "effect"
import { SessionSchema } from "./session/schema"
import { SystemContext } from "./system-context/index"

export const Entry = Schema.Struct({
  id: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
})
export type Entry = typeof Entry.Type

export const Info = Schema.Struct({
  builtin: Entry.pipe(Schema.optional),
  developer: Schema.Array(Entry),
  userDeveloper: Schema.Array(Entry),
})
export type Info = typeof Info.Type

export interface Interface {
  readonly set: (sessionID: SessionSchema.ID, input: Info) => Effect.Effect<void>
  readonly context: (sessionID: SessionSchema.ID) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionInstructionOverlay") {}

const key = SystemContext.Key.make("app-server/session-instructions")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const entries = yield* Ref.make<ReadonlyMap<SessionSchema.ID, Info>>(new Map())

    return Service.of({
      set: Effect.fn("SessionInstructionOverlay.set")(function* (sessionID, input) {
        yield* Ref.update(entries, (current) => new Map(current).set(sessionID, input))
      }),
      context: Effect.fn("SessionInstructionOverlay.context")(function* (sessionID) {
        const current = yield* Ref.get(entries)
        const info = current.get(sessionID)
        if (!info || !hasContent(info)) return SystemContext.empty
        return SystemContext.make({
          key,
          codec: Schema.toCodecJson(Info),
          load: Effect.succeed(info),
          baseline: render,
          update: (_previous, current) =>
            `These session instructions replace all previously loaded app-server session instructions.\n\n${render(current)}`,
          removed: () => "Previously loaded app-server session instructions no longer apply.",
        })
      }),
    })
  }),
)

export const locationLayer = layer

function hasContent(info: Info) {
  return info.builtin !== undefined || info.developer.length > 0 || info.userDeveloper.length > 0
}

function render(info: Info) {
  return [
    info.builtin?.text,
    renderGroup("developer_instructions", info.developer),
    renderGroup("user_developer_instructions", info.userDeveloper),
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n\n")
}

function renderGroup(title: string, entries: ReadonlyArray<Entry>) {
  if (entries.length === 0) return
  return [
    `<${title}>`,
    entries.map((entry) => [`Instructions from: ${entry.id}`, entry.text].join("\n")).join("\n\n"),
    `</${title}>`,
  ].join("\n")
}
