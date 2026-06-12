import { createInterface } from "node:readline"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import { EOL } from "os"
import { Cause, DateTime, Effect, Exit, JsonSchema, ManagedRuntime, Option, Schema, Scope } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { Tool, ToolFailure } from "@opencode-ai/llm"
import { effectCmd } from "../effect-cmd"
import { AbsolutePath, Location, Model, OpenCode, Prompt, Session } from "@opencode-ai/core/public"
import { Catalog } from "@opencode-ai/core/catalog"
import { EventV2 } from "@opencode-ai/core/event"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { ModelV2 } from "@opencode-ai/core/model"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { QuestionV2 } from "@opencode-ai/core/question"
import { SessionInstructionOverlay } from "@opencode-ai/core/session-instruction-overlay"
import { NativeTool } from "@opencode-ai/core/tool/native"
import { NamedError } from "@opencode-ai/core/util/error"
import { Provider } from "../../provider/provider"

const ProtocolVersion = "0.1.0"

type JsonRpcID = string | number | null

type JsonRpcRequest = {
  readonly jsonrpc?: unknown
  readonly id?: unknown
  readonly method?: unknown
  readonly params?: unknown
}

type JsonRpcResponse =
  | {
      readonly jsonrpc: "2.0"
      readonly id: JsonRpcID
      readonly result: unknown
    }
  | {
      readonly jsonrpc: "2.0"
      readonly id: JsonRpcID
      readonly error: {
        readonly code: number
        readonly message: string
        readonly data?: unknown
      }
    }

type JsonRpcNotification = {
  readonly jsonrpc: "2.0"
  readonly method: string
  readonly params: Record<string, unknown>
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification

type NotificationEmitter = (method: string, params: Record<string, unknown>) => void
type NotificationCleanup = () => Promise<void>
type LocationServices = { readonly get: typeof LocationServiceMap.get }

type ServerInitializeResult = {
  readonly serverName: "opencode-app-server"
  readonly protocolVersion: typeof ProtocolVersion
  readonly capabilities: {
    readonly sessions: true
    readonly resume: true
    readonly turns: true
    readonly cancellation: true
    readonly tools: false
    readonly models: true
    readonly providers: true
    readonly approvals: true
    readonly userInput: true
    readonly mcp: true
  }
}

type ProviderListResult = {
  readonly data: readonly ProviderInfo[]
  readonly default?: string
}

type ProviderInfo = {
  readonly id: string
  readonly value: string
  readonly name: string
  readonly label: string
  readonly displayName: string
  readonly defaultModel?: string
  readonly source: string
  readonly capabilities: Record<string, unknown>
}

type ProviderListParams = {
  readonly cwd?: string
}

type ModelListParams = {
  readonly provider?: string
  readonly cwd?: string
}

type ModelVariantListParams = {
  readonly provider?: string
  readonly model?: string
  readonly cwd?: string
}

type ModelListResult = {
  readonly data: readonly ModelInfo[]
  readonly default?: string
}

type ModelVariantListResult = {
  readonly data: readonly ModelVariantInfo[]
  readonly default?: string
}

type RuntimeVariantIndex = ReadonlyMap<string, Record<string, Record<string, unknown>>>

type ModelVariantInfo = {
  readonly id: string
  readonly value: string
  readonly label: string
  readonly variant: string
  readonly reasoningEffort: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
  readonly generation: Record<string, unknown>
  readonly options: Record<string, unknown>
  readonly request: {
    readonly headers: Record<string, string>
    readonly body: Record<string, unknown>
    readonly generation: Record<string, unknown>
    readonly options: Record<string, unknown>
  }
  readonly raw: Record<string, unknown>
}

type ModelInfo = {
  readonly id: string
  readonly value: string
  readonly provider: string
  readonly providerID: string
  readonly model: string
  readonly modelID: string
  readonly name: string
  readonly label: string
  readonly displayName: string
  readonly family: string
  readonly supported_reasoning_efforts: readonly ModelVariantInfo[]
  readonly supportedReasoningEfforts: readonly ModelVariantInfo[]
  readonly default_reasoning_effort: string
  readonly defaultReasoningEffort: string
  readonly features: {
    readonly thinking: boolean
    readonly multimodalToolUse: boolean
  }
  readonly capabilities: Record<string, unknown>
}

type HandlerResult = {
  readonly response?: JsonRpcResponse
  readonly shutdown?: true
}

type SessionCreateParams = {
  readonly cwd: string
  readonly sessionId?: string
} & ModelSelectionParams &
  InstructionParams &
  McpParams

type ModelSelectionParams = {
  readonly provider?: string
  readonly model?: string
  readonly variant?: string
  readonly reasoningEffort?: string
}

type InstructionEntry = {
  readonly id: string
  readonly text: string
}

type InstructionParams = {
  readonly hostPlatform?: string
  readonly builtinInstructions?: "app-server" | "none"
  readonly developerInstructions: readonly InstructionEntry[]
  readonly userDeveloperInstructions: readonly InstructionEntry[]
}

type McpParams = {
  readonly mcpServers?: Record<string, McpServerConfig>
}

type McpServerConfig = McpRemoteServerConfig | McpLocalServerConfig

type McpRemoteServerConfig = {
  readonly type: "remote"
  readonly url: string
  readonly headers?: Record<string, string>
  readonly transport?: "streamable-http" | "sse"
  readonly disabled?: boolean
  readonly timeout?: number
}

type McpLocalServerConfig = {
  readonly type: "local"
  readonly command: readonly string[]
  readonly environment?: Record<string, string>
  readonly cwd?: string
  readonly disabled?: boolean
  readonly timeout?: number
}

type SessionListParams = {
  readonly cwd?: string
  readonly limit?: number
  readonly order?: "asc" | "desc"
}

type SessionStatusParams = {
  readonly sessionId: string
}

type SessionResumeParams = {
  readonly sessionId: string
} & ModelSelectionParams &
  InstructionParams &
  McpParams

type SessionInfo = {
  readonly sessionId: string
  readonly providerSessionId: string
  readonly threadId: string
  readonly cwd: string
  readonly provider?: string
  readonly model?: string
  readonly variant?: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
}

type SessionCreateResult = {
  readonly sessionId: string
  readonly providerSessionId: string
  readonly threadId: string
  readonly cwd: string
  readonly provider?: string
  readonly model?: string
  readonly createdAt?: string
}

type SessionListResult = {
  readonly data: readonly SessionInfo[]
}

type SessionStatusResult = SessionInfo & {
  readonly exists: true
  readonly active: false
  readonly busy: false
  readonly pending: false
  readonly status: "idle"
}

type SessionResumeResult = {
  readonly resumed: true
  readonly sessionId: string
  readonly providerSessionId: string
  readonly threadId: string
}

type TurnStartParams = {
  readonly sessionId: string
  readonly turnId?: string
  readonly messageId?: string
  readonly prompt: string
  readonly delivery?: "steer" | "queue"
} & ModelSelectionParams &
  InstructionParams &
  McpParams

type TurnStartResult = {
  readonly accepted: true
  readonly turnId: string
  readonly sessionId: string
  readonly providerSessionId: string
  readonly threadId: string
  readonly messageId: string
  readonly delivery: "steer" | "queue"
}

type TurnCancelParams = {
  readonly sessionId: string
  readonly turnId?: string
}

type TurnCancelResult = {
  readonly cancelled: true
  readonly active: boolean
  readonly sessionId: string
  readonly providerSessionId: string
  readonly threadId: string
  readonly turnId?: string
}

type ToolApprovalRespondParams = {
  readonly sessionId: string
  readonly requestId: string
  readonly reply: PermissionV2.Reply
  readonly message?: string
}

type ToolApprovalRespondResult = {
  readonly ok: true
  readonly sessionId: string
  readonly providerSessionId: string
  readonly threadId: string
  readonly requestId: string
  readonly approvalId: string
  readonly reply: PermissionV2.Reply
}

type UserInputRespondParams = {
  readonly sessionId: string
  readonly requestId: string
  readonly answers: readonly (readonly string[])[]
}

type UserInputRespondResult = {
  readonly ok: true
  readonly sessionId: string
  readonly providerSessionId: string
  readonly threadId: string
  readonly requestId: string
  readonly answers: readonly (readonly string[])[]
}

type UserInputRejectParams = {
  readonly sessionId: string
  readonly requestId: string
}

type UserInputRejectResult = {
  readonly ok: true
  readonly rejected: true
  readonly sessionId: string
  readonly providerSessionId: string
  readonly threadId: string
  readonly requestId: string
}

type AppServerServices = {
  readonly listProviders: (params: ProviderListParams) => Promise<ProviderListResult>
  readonly listModels: (params: ModelListParams) => Promise<ModelListResult>
  readonly listModelVariants: (params: ModelVariantListParams) => Promise<ModelVariantListResult>
  readonly createSession: (params: SessionCreateParams) => Promise<SessionCreateResult>
  readonly listSessions: (params: SessionListParams) => Promise<SessionListResult>
  readonly getSessionStatus: (params: SessionStatusParams) => Promise<SessionStatusResult>
  readonly resumeSession: (params: SessionResumeParams) => Promise<SessionResumeResult>
  readonly startTurn: (params: TurnStartParams, emit: NotificationEmitter) => Promise<TurnStartResult>
  readonly cancelTurn: (params: TurnCancelParams) => Promise<TurnCancelResult>
  readonly respondToolApproval: (params: ToolApprovalRespondParams) => Promise<ToolApprovalRespondResult>
  readonly respondUserInput: (params: UserInputRespondParams) => Promise<UserInputRespondResult>
  readonly rejectUserInput: (params: UserInputRejectParams) => Promise<UserInputRejectResult>
}

export type ActiveTurn = {
  readonly turnId: string
  readonly sessionId: string
  readonly content: string[]
  readonly reasoning: string[]
  readonly contextWindow?: number
  readonly cleanup?: NotificationCleanup
}

class AppServerError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

type McpBridgeStatus = {
  readonly servers: Record<string, McpBridgeServerStatus>
}

type McpBridgeServerStatus =
  | { readonly status: "connected"; readonly toolCount: number }
  | { readonly status: "disabled" }
  | { readonly status: "failed"; readonly error: string }

type McpToolDefinition = {
  readonly name: string
  readonly description?: string
  readonly inputSchema: Record<string, unknown>
}

type McpToolContent = {
  readonly type?: unknown
  readonly text?: unknown
  readonly data?: unknown
  readonly mimeType?: unknown
}

type McpConnectResult = {
  readonly clients: readonly Client[]
  readonly tools: Record<string, NativeTool.Any>
  readonly status: Record<string, McpBridgeServerStatus>
}

function createMcpToolBridge() {
  let registrationKey = ""
  let clients: readonly Client[] = []
  let attachmentScope: Scope.Closeable | undefined
  let status: Record<string, McpBridgeServerStatus> = {}

  const closeCurrent = Effect.fn("AppServerMcp.closeCurrent")(function* () {
    if (attachmentScope) {
      yield* Scope.close(attachmentScope, Exit.void)
      attachmentScope = undefined
    }
    const staleClients = clients
    clients = []
    yield* Effect.promise(() => Promise.all(staleClients.map((client) => client.close().catch(() => undefined))))
  })

  return {
    status: (): McpBridgeStatus => ({ servers: { ...status } }),
    sync: Effect.fn("AppServerMcp.sync")(function* (
      params: McpParams,
      opencode: OpenCode.Interface,
      cwd: string,
    ) {
      if (params.mcpServers === undefined) return
      const nextKey = stableStringify(params.mcpServers)
      if (nextKey === registrationKey) return

      yield* closeCurrent()
      registrationKey = nextKey
      status = Object.fromEntries(
        Object.entries(params.mcpServers)
          .filter((entry) => entry[1].disabled === true)
          .map(([name]) => [name, { status: "disabled" as const }]),
      )

      const active = Object.fromEntries(Object.entries(params.mcpServers).filter((entry) => entry[1].disabled !== true))
      if (Object.keys(active).length === 0) return

      const connected = yield* Effect.promise(() => connectMcpServers(active, cwd))
      const scope = yield* Scope.make()
      yield* opencode.tools.attach(connected.tools).pipe(Scope.provide(scope))
      attachmentScope = scope
      clients = connected.clients
      status = { ...status, ...connected.status }
    }),
    dispose: closeCurrent,
  }
}

async function connectMcpServers(servers: Record<string, McpServerConfig>, cwd: string): Promise<McpConnectResult> {
  const clients: Client[] = []
  const tools: Record<string, NativeTool.Any> = {}
  const status: Record<string, McpBridgeServerStatus> = {}
  try {
    for (const [serverName, config] of Object.entries(servers)) {
      const client = await connectMcpServer(serverName, config, cwd)
      clients.push(client)
      const listed = await client.listTools(undefined, { timeout: config.timeout })
      for (const item of listed.tools) {
        const tool = mcpToolDefinition(item)
        tools[mcpToolName(serverName, tool.name)] = mcpApplicationTool(serverName, client, tool, config.timeout)
      }
      status[serverName] = { status: "connected", toolCount: listed.tools.length }
    }
    return { clients, tools, status }
  } catch (error) {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)))
    throw error
  }
}

async function connectMcpServer(serverName: string, config: McpServerConfig, cwd: string) {
  const client = new Client({ name: "opencode-app-server", version: ProtocolVersion })
  if (config.type === "remote") {
    const url = new URL(config.url)
    const transport =
      config.transport === "sse"
        ? new SSEClientTransport(url, { requestInit: config.headers ? { headers: config.headers } : undefined })
        : new StreamableHTTPClientTransport(url, {
            requestInit: config.headers ? { headers: config.headers } : undefined,
          })
    await timeoutPromise(client.connect(transport), config.timeout, `MCP server ${serverName} connection timed out`)
    return client
  }

  const [command, ...args] = config.command
  if (!command) throw new Error(`MCP server ${serverName} command is empty`)
  await timeoutPromise(
    client.connect(
      new StdioClientTransport({
        stderr: "pipe",
        command,
        args,
        cwd: config.cwd ?? cwd,
      env: {
        ...processEnvironment(),
        ...config.environment,
      },
      }),
    ),
    config.timeout,
    `MCP server ${serverName} connection timed out`,
  )
  return client
}

async function timeoutPromise<T>(promise: Promise<T>, timeout: number | undefined, message: string): Promise<T> {
  if (timeout === undefined) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function mcpToolDefinition(value: unknown): McpToolDefinition {
  const tool = record(value)
  const name = stringValue(tool.name)
  if (!name) throw new Error("MCP tool is missing a name")
  const inputSchema = record(tool.inputSchema)
  if (Object.keys(inputSchema).length === 0) throw new Error(`MCP tool ${name} is missing inputSchema`)
  return {
    name,
    description: stringValue(tool.description),
    inputSchema,
  }
}

function mcpApplicationTool(
  serverName: string,
  client: Client,
  tool: McpToolDefinition,
  timeout: number | undefined,
) {
  return {
    definition: Tool.make({
      description: tool.description ?? "",
      jsonSchema: mcpJsonSchema(tool.inputSchema),
      toModelOutput: ({ output }) => mcpResultContent(record(output).content),
    }),
    execute: (params) =>
      Effect.tryPromise({
        try: async () => {
          const result = await client.callTool(
            { name: tool.name, arguments: record(params) },
            CallToolResultSchema,
            { resetTimeoutOnProgress: true, timeout },
          )
          if (result.isError)
            throw new Error(mcpResultText(mcpToolContentList(result.content)) || `MCP tool failed: ${serverName}/${tool.name}`)
          return result
        },
        catch: (error) =>
          new ToolFailure({
            message: error instanceof Error ? error.message : String(error),
            error,
          }),
      }),
  } satisfies NativeTool.Any
}

function mcpJsonSchema(inputSchema: Record<string, unknown>): JsonSchema.JsonSchema {
  return {
    ...inputSchema,
    type: "object",
    properties: record(inputSchema.properties),
  } as JsonSchema.JsonSchema
}

function mcpResultContent(value: unknown) {
  const text = mcpResultText(mcpToolContentList(value))
  return text ? [{ type: "text" as const, text }] : []
}

function mcpToolContentList(value: unknown) {
  return Array.isArray(value) ? value.map((item) => record(item) as McpToolContent) : []
}

function mcpResultText(content: readonly McpToolContent[] | undefined) {
  return (content ?? [])
    .flatMap((item) => (item.type === "text" && typeof item.text === "string" ? [item.text] : []))
    .join("\n")
}

function processEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function mcpToolName(serverName: string, toolName: string) {
  return `${sanitizeIdentifier(serverName)}_${sanitizeIdentifier(toolName)}`
}

function sanitizeIdentifier(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableJson(value))
}

function stableJson(value: unknown): unknown {
  if (!value || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(stableJson)
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [
    key,
    stableJson(item),
  ]))
}

export const AppServerCommand = effectCmd({
  command: "app-server",
  describe: "start stdio JSON-RPC app server",
  instance: false,
  handler: Effect.fn("Cli.appServer")(function* () {
    routeConsoleToStderr()
    const openCodeRuntime = ManagedRuntime.make(OpenCode.appServerLayer)
    const activeTurns = new Map<string, ActiveTurn>()
    const mcpBridge = createMcpToolBridge()
    yield* Effect.promise(() =>
      runAppServer({
        listProviders: (params) =>
          openCodeRuntime.runPromise(
            Effect.gen(function* () {
              const locations = yield* LocationServiceMap
              const cwd = resolveCwd(params.cwd ?? process.cwd())
              return yield* Effect.gen(function* () {
                yield* (yield* PluginBoot.Service).wait()
                const catalog = yield* Catalog.Service
                const providers = (yield* catalog.provider.all()).filter(discoverableProvider)
                const models = discoverableModels(providers, yield* catalog.model.all())
                const defaultModel = yield* catalog.model.default()
                return providerListResult(providers, models, defaultModel)
              }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(cwd) }))))
            }),
          ),
        listModels: (params) =>
          openCodeRuntime.runPromise(
            Effect.gen(function* () {
              const locations = yield* LocationServiceMap
              const cwd = resolveCwd(params.cwd ?? process.cwd())
              return yield* Effect.gen(function* () {
                yield* (yield* PluginBoot.Service).wait()
                const catalog = yield* Catalog.Service
                const providers = (yield* catalog.provider.all()).filter(discoverableProvider)
                const models = discoverableModels(providers, yield* catalog.model.all())
                const defaultModel = yield* catalog.model.default()
                const runtimeVariants = yield* runtimeVariantIndexEffect()
                return modelListResult(providers, models, defaultModel, params, runtimeVariants)
              }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(cwd) }))))
            }),
          ),
        listModelVariants: (params) =>
          openCodeRuntime.runPromise(
            Effect.gen(function* () {
              const locations = yield* LocationServiceMap
              const cwd = resolveCwd(params.cwd ?? process.cwd())
              return yield* Effect.gen(function* () {
                yield* (yield* PluginBoot.Service).wait()
                const catalog = yield* Catalog.Service
                const providers = (yield* catalog.provider.all()).filter(discoverableProvider)
                const models = discoverableModels(providers, yield* catalog.model.all())
                const runtimeVariants = yield* runtimeVariantIndexEffect()
                return modelVariantListResult(models, params, runtimeVariants)
              }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(cwd) }))))
            }),
          ),
        createSession: (params) =>
          openCodeRuntime.runPromise(
            Effect.gen(function* () {
              const opencode = yield* OpenCode.Service
              const locations = yield* LocationServiceMap
              const cwd = resolveCwd(params.cwd)
              const location = Location.Ref.make({ directory: AbsolutePath.make(cwd) })
              yield* mcpBridge.sync(params, opencode, cwd)
              const model = modelRef(params)
              if (model) {
                yield* Effect.gen(function* () {
                  yield* (yield* PluginBoot.Service).wait()
                  const catalog = yield* Catalog.Service
                  const catalogModel = yield* catalog.model.get(model.providerID, model.id).pipe(
                    Effect.catch(() =>
                      Effect.fail(new AppServerError(-32030, `Model not found: ${model.providerID}/${model.id}`)),
                    ),
                  )
                  if (
                    model.variant !== undefined &&
                    model.variant !== "default" &&
                    !catalogModel.variants.some((variant) => variant.id === model.variant)
                  ) {
                    return yield* Effect.fail(
                      new AppServerError(
                        -32031,
                        `Model variant not found: ${model.providerID}/${model.id}/${model.variant}`,
                      ),
                    )
                  }
                }).pipe(Effect.provide(locations.get(location)))
              }
              const session = yield* opencode.sessions.create({
                id: params.sessionId ? createSessionID(params.sessionId) : undefined,
                location,
                model,
              })
              yield* applyInstructionOverlay(
                params,
                session,
                yield* instructionModelRef(locations, session.location, model),
                locations,
              )
              return sessionCreateResult(session, params)
            }),
          ),
        listSessions: (params) =>
          openCodeRuntime.runPromise(
            Effect.gen(function* () {
              const opencode = yield* OpenCode.Service
              const sessions = yield* opencode.sessions.list({
                ...(params.cwd ? { directory: AbsolutePath.make(resolveCwd(params.cwd)) } : {}),
                ...(params.limit ? { limit: params.limit } : {}),
                ...(params.order ? { order: params.order } : {}),
              })
              return { data: sessions.map((session) => sessionInfo(session)) }
            }),
          ),
        getSessionStatus: (params) =>
          openCodeRuntime.runPromise(
            Effect.gen(function* () {
              const opencode = yield* OpenCode.Service
              const session = yield* opencode.sessions.get(loadedSessionID(params.sessionId)).pipe(
                Effect.catchTag(
                  "Session.NotFoundError",
                  () => Effect.fail(new AppServerError(-32010, `Session not found: ${params.sessionId}`)),
                ),
              )
              return sessionStatusResult(session)
            }),
          ),
        resumeSession: (params) =>
          openCodeRuntime.runPromise(
            Effect.gen(function* () {
              const opencode = yield* OpenCode.Service
              const locations = yield* LocationServiceMap
              const id = loadedSessionID(params.sessionId)
              const session = yield* opencode.sessions.get(id).pipe(
                Effect.catchTag(
                  "Session.NotFoundError",
                  () => Effect.fail(new AppServerError(-32010, `Session not found: ${params.sessionId}`)),
                ),
              )
              yield* mcpBridge.sync(params, opencode, session.location.directory)
              const model = modelRef(params)
              if (model) {
                yield* opencode.sessions.switchModel({ sessionID: id, model }).pipe(
                  Effect.catchTag("Session.NotFoundError", () =>
                    Effect.fail(new AppServerError(-32010, `Session not found: ${params.sessionId}`)),
                  ),
                  Effect.catchTag("Session.ModelUnavailableError", (error) =>
                    Effect.fail(new AppServerError(-32030, `Model not found: ${error.providerID}/${error.modelID}`)),
                  ),
                  Effect.catchTag("Session.VariantUnavailableError", (error) =>
                    Effect.fail(
                      new AppServerError(
                        -32031,
                        `Model variant not found: ${error.providerID}/${error.modelID}/${error.variant}`,
                      ),
                    ),
                  ),
                )
              }
              yield* applyInstructionOverlay(
                params,
                session,
                yield* instructionModelRef(locations, session.location, model ?? session.model),
                locations,
              )
              yield* opencode.sessions.resume(session.id)
              return sessionResumeResult(session)
            }),
          ),
        startTurn: (params, emit) =>
          openCodeRuntime.runPromise(
            Effect.gen(function* () {
              const opencode = yield* OpenCode.Service
              const locations = yield* LocationServiceMap
              const id = loadedSessionID(params.sessionId)
              const session = yield* opencode.sessions.get(id).pipe(
                Effect.catchTag(
                  "Session.NotFoundError",
                  () => Effect.fail(new AppServerError(-32010, `Session not found: ${params.sessionId}`)),
                ),
              )
              yield* mcpBridge.sync(params, opencode, session.location.directory)
              if (activeTurns.has(session.id)) {
                return yield* Effect.fail(new AppServerError(-32020, `Session already has an active turn: ${session.id}`))
              }
              const requestedModel = modelRef(params)
              if (requestedModel) {
                yield* opencode.sessions.switchModel({ sessionID: id, model: requestedModel }).pipe(
                  Effect.catchTag("Session.NotFoundError", () =>
                    Effect.fail(new AppServerError(-32010, `Session not found: ${params.sessionId}`)),
                  ),
                  Effect.catchTag("Session.ModelUnavailableError", (error) =>
                    Effect.fail(new AppServerError(-32030, `Model not found: ${error.providerID}/${error.modelID}`)),
                  ),
                  Effect.catchTag("Session.VariantUnavailableError", (error) =>
                    Effect.fail(
                      new AppServerError(
                        -32031,
                        `Model variant not found: ${error.providerID}/${error.modelID}/${error.variant}`,
                      ),
                    ),
                  ),
                )
              }
              const turnId = params.turnId ?? randomUUID()
              const selectedModel = requestedModel ?? session.model
              yield* applyInstructionOverlay(
                params,
                session,
                yield* instructionModelRef(locations, session.location, selectedModel),
                locations,
              )
              const contextWindow =
                selectedModel === undefined
                  ? undefined
                  : yield* Effect.gen(function* () {
                      yield* (yield* PluginBoot.Service).wait()
                      const catalog = yield* Catalog.Service
                      return positiveNumber((yield* catalog.model.get(selectedModel.providerID, selectedModel.id)).limit.context)
                    }).pipe(Effect.provide(locations.get(session.location)), Effect.catch(() => Effect.succeed(undefined)))
              const unsubscribe = yield* Effect.gen(function* () {
                const events = yield* EventV2.Service
                return yield* events.listen((event) =>
                  Effect.sync(() => {
                    for (const item of turnNotifications(activeTurns, event)) {
                      emit(item.method, item.params)
                    }
                  }),
                )
              }).pipe(Effect.provide(locations.get(session.location)))
              activeTurns.set(session.id, {
                turnId,
                sessionId: session.id,
                content: [],
                reasoning: [],
                ...(contextWindow === undefined ? {} : { contextWindow }),
                cleanup: () => Effect.runPromise(unsubscribe),
              })
              const admission = yield* opencode.sessions
                .prompt({
                  ...(params.messageId ? { id: Session.MessageID.make(params.messageId) } : {}),
                  sessionID: id,
                  prompt: Prompt.fromUserMessage({ text: params.prompt }),
                  delivery: params.delivery,
                })
                .pipe(Effect.tapError(() => Effect.promise(() => cleanupActiveTurn(activeTurns, session.id))))
              yield* opencode.sessions
                .resume(session.id)
                .pipe(
                  Effect.catchCause((cause: Cause.Cause<unknown>) =>
                    Effect.sync(() => {
                      for (const item of turnFailureNotifications(activeTurns, session.id, causeError(cause))) {
                        emit(item.method, item.params)
                      }
                    }),
                  ),
                  Effect.forkDetach,
                )
              return {
                accepted: true,
                turnId,
                sessionId: session.id,
                providerSessionId: session.id,
                threadId: session.id,
                messageId: admission.id,
                delivery: admission.delivery,
              }
            }),
          ),
        cancelTurn: (params) =>
          openCodeRuntime.runPromise(
            Effect.gen(function* () {
              const opencode = yield* OpenCode.Service
              const id = loadedSessionID(params.sessionId)
              const session = yield* opencode.sessions.get(id).pipe(
                Effect.catchTag(
                  "Session.NotFoundError",
                  () => Effect.fail(new AppServerError(-32010, `Session not found: ${params.sessionId}`)),
                ),
              )
              const active = activeTurns.get(session.id)
              if (params.turnId && active && params.turnId !== active.turnId) {
                return yield* Effect.fail(
                  new AppServerError(-32020, `Session has a different active turn: ${session.id}`),
                )
              }
              yield* opencode.sessions.interrupt(session.id)
              return turnCancelResult(session, active)
            }),
          ),
        respondToolApproval: (params) =>
          openCodeRuntime.runPromise(
            Effect.gen(function* () {
              const opencode = yield* OpenCode.Service
              const locations = yield* LocationServiceMap
              const id = loadedSessionID(params.sessionId)
              const session = yield* opencode.sessions.get(id).pipe(
                Effect.catchTag(
                  "Session.NotFoundError",
                  () => Effect.fail(new AppServerError(-32010, `Session not found: ${params.sessionId}`)),
                ),
              )
              yield* Effect.gen(function* () {
                const permission = yield* PermissionV2.Service
                yield* permission
                  .reply({
                    requestID: PermissionV2.ID.make(params.requestId),
                    reply: params.reply,
                    message: params.message,
                  })
                  .pipe(
                    Effect.catchTag("PermissionV2.NotFoundError", () =>
                      Effect.fail(new AppServerError(-32040, `Permission request not found: ${params.requestId}`)),
                    ),
                  )
              }).pipe(Effect.provide(locations.get(session.location)))
              return toolApprovalRespondResult(session, params)
            }),
          ),
        respondUserInput: (params) =>
          openCodeRuntime.runPromise(
            Effect.gen(function* () {
              const opencode = yield* OpenCode.Service
              const locations = yield* LocationServiceMap
              const id = loadedSessionID(params.sessionId)
              const session = yield* opencode.sessions.get(id).pipe(
                Effect.catchTag(
                  "Session.NotFoundError",
                  () => Effect.fail(new AppServerError(-32010, `Session not found: ${params.sessionId}`)),
                ),
              )
              yield* Effect.gen(function* () {
                const questions = yield* QuestionV2.Service
                yield* questions
                  .reply({
                    requestID: questionRequestID(params.requestId),
                    answers: params.answers,
                  })
                  .pipe(
                    Effect.catchTag("QuestionV2.NotFoundError", () =>
                      Effect.fail(new AppServerError(-32050, `Question request not found: ${params.requestId}`)),
                    ),
                  )
              }).pipe(Effect.provide(locations.get(session.location)))
              return userInputRespondResult(session, params)
            }),
          ),
        rejectUserInput: (params) =>
          openCodeRuntime.runPromise(
            Effect.gen(function* () {
              const opencode = yield* OpenCode.Service
              const locations = yield* LocationServiceMap
              const id = loadedSessionID(params.sessionId)
              const session = yield* opencode.sessions.get(id).pipe(
                Effect.catchTag(
                  "Session.NotFoundError",
                  () => Effect.fail(new AppServerError(-32010, `Session not found: ${params.sessionId}`)),
                ),
              )
              yield* Effect.gen(function* () {
                const questions = yield* QuestionV2.Service
                yield* questions.reject(questionRequestID(params.requestId)).pipe(
                  Effect.catchTag("QuestionV2.NotFoundError", () =>
                    Effect.fail(new AppServerError(-32050, `Question request not found: ${params.requestId}`)),
                  ),
                )
              }).pipe(Effect.provide(locations.get(session.location)))
              return userInputRejectResult(session, params)
            }),
          ),
      }),
    ).pipe(
      Effect.ensuring(
        mcpBridge.dispose().pipe(Effect.andThen(Effect.promise(() => openCodeRuntime.dispose()).pipe(Effect.ignore))),
      ),
    )
  }),
})

function routeConsoleToStderr() {
  console.log = (...input) => console.error(...input)
  console.info = (...input) => console.error(...input)
  console.debug = (...input) => console.error(...input)
}

export async function runAppServer(services: AppServerServices) {
  const writer = jsonRpcWriter()
  const emit: NotificationEmitter = (method, params) => {
    void writer.write(notification(method, params))
  }
  const lines = createInterface({
    input: process.stdin,
    terminal: false,
    crlfDelay: Infinity,
  })

  try {
    for await (const line of lines) {
      const result = await handleLine(line, services, emit)
      if (result.response) await writer.write(result.response)
      if (result.shutdown) break
    }
  } finally {
    lines.close()
  }
}

export async function handleLine(
  line: string,
  services: AppServerServices,
  emit: NotificationEmitter = () => {},
): Promise<HandlerResult> {
  const trimmed = line.trim()
  if (!trimmed) return {}

  const parsed = parseRequest(trimmed)
  if (!parsed.ok) return { response: error(null, -32700, "Parse error") }

  const request = parsed.value
  const id = jsonRpcID(request.id)
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string" || id.invalid) {
    return { response: error(id.value, -32600, "Invalid request") }
  }

  if (request.id === undefined) {
    return request.method === "server/shutdown" ? { shutdown: true } : {}
  }

  if (request.method === "server/initialize") {
    return { response: result(id.value, initializeResult()) }
  }

  if (request.method === "provider/list") {
    const params = providerListParams(request.params)
    if (!params) return { response: error(id.value, -32602, "Invalid params") }
    return handleAsync(id.value, request.method, () => services.listProviders(params))
  }

  if (request.method === "model/list") {
    const params = modelListParams(request.params)
    if (!params) return { response: error(id.value, -32602, "Invalid params") }
    return handleAsync(id.value, request.method, () => services.listModels(params))
  }

  if (request.method === "model/variant/list") {
    const params = modelVariantListParams(request.params)
    if (!params) return { response: error(id.value, -32602, "Invalid params") }
    return handleAsync(id.value, request.method, () => services.listModelVariants(params))
  }

  if (request.method === "session/create") {
    const params = sessionCreateParams(request.params)
    if (!params) return { response: error(id.value, -32602, "Invalid params") }
    return handleAsync(id.value, request.method, () => services.createSession(params))
  }

  if (request.method === "session/list") {
    const params = sessionListParams(request.params)
    if (!params) return { response: error(id.value, -32602, "Invalid params") }
    return handleAsync(id.value, request.method, () => services.listSessions(params))
  }

  if (request.method === "session/status") {
    const params = sessionStatusParams(request.params)
    if (!params) return { response: error(id.value, -32602, "Invalid params") }
    return handleAsync(id.value, request.method, () => services.getSessionStatus(params))
  }

  if (request.method === "session/resume") {
    const params = sessionResumeParams(request.params)
    if (!params) return { response: error(id.value, -32602, "Invalid params") }
    return handleAsync(id.value, request.method, () => services.resumeSession(params))
  }

  if (request.method === "turn/start") {
    const params = turnStartParams(request.params)
    if (!params) return { response: error(id.value, -32602, "Invalid params") }
    return handleAsync(id.value, request.method, () => services.startTurn(params, emit))
  }

  if (request.method === "turn/cancel") {
    const params = turnCancelParams(request.params)
    if (!params) return { response: error(id.value, -32602, "Invalid params") }
    return handleAsync(id.value, request.method, () => services.cancelTurn(params))
  }

  if (request.method === "turn/toolApproval/respond") {
    const params = toolApprovalRespondParams(request.params)
    if (!params) return { response: error(id.value, -32602, "Invalid params") }
    return handleAsync(id.value, request.method, () => services.respondToolApproval(params))
  }

  if (request.method === "turn/userInput/respond") {
    const params = userInputRespondParams(request.params)
    if (!params) return { response: error(id.value, -32602, "Invalid params") }
    return handleAsync(id.value, request.method, () => services.respondUserInput(params))
  }

  if (request.method === "turn/userInput/reject") {
    const params = userInputRejectParams(request.params)
    if (!params) return { response: error(id.value, -32602, "Invalid params") }
    return handleAsync(id.value, request.method, () => services.rejectUserInput(params))
  }

  if (request.method === "server/shutdown") {
    return { response: result(id.value, { ok: true }), shutdown: true }
  }

  return { response: error(id.value, -32601, `Method not found: ${request.method}`) }
}

async function handleAsync(id: JsonRpcID, method: string, fn: () => Promise<unknown>): Promise<HandlerResult> {
  try {
    return { response: result(id, await fn()) }
  } catch (cause) {
    if (cause instanceof AppServerError) return { response: error(id, cause.code, cause.message) }
    const details = errorDetails(method, cause)
    return { response: error(id, -32603, details.message, details.data) }
  }
}

function parseRequest(line: string): { readonly ok: true; readonly value: JsonRpcRequest } | { readonly ok: false } {
  try {
    const value = JSON.parse(line)
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false }
    return { ok: true, value: value as JsonRpcRequest }
  } catch {
    return { ok: false }
  }
}

function jsonRpcID(value: unknown): { readonly value: JsonRpcID; readonly invalid?: true } {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number") {
    return { value: value === undefined ? null : value }
  }
  return { value: null, invalid: true }
}

function paramsObject(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return {}
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function providerListParams(value: unknown): ProviderListParams | undefined {
  const params = paramsObject(value)
  if (!params) return undefined
  if (params.cwd !== undefined && typeof params.cwd !== "string") return undefined
  return { cwd: params.cwd }
}

function modelListParams(value: unknown): ModelListParams | undefined {
  const params = paramsObject(value)
  if (!params) return undefined
  if (params.provider !== undefined && typeof params.provider !== "string") return undefined
  if (params.cwd !== undefined && typeof params.cwd !== "string") return undefined
  return { provider: params.provider, cwd: params.cwd }
}

function modelVariantListParams(value: unknown): ModelVariantListParams | undefined {
  const params = paramsObject(value)
  if (!params) return undefined
  if (params.provider !== undefined && typeof params.provider !== "string") return undefined
  if (params.model !== undefined && typeof params.model !== "string") return undefined
  if (params.cwd !== undefined && typeof params.cwd !== "string") return undefined
  return { provider: params.provider, model: params.model, cwd: params.cwd }
}

function sessionCreateParams(value: unknown): SessionCreateParams | undefined {
  const params = paramsObject(value)
  if (!params) return undefined
  if (typeof params.cwd !== "string" || params.cwd.trim() === "") return undefined
  if (params.sessionId !== undefined && typeof params.sessionId !== "string") return undefined
  if (params.provider !== undefined && typeof params.provider !== "string") return undefined
  if (params.model !== undefined && typeof params.model !== "string") return undefined
  if (params.variant !== undefined && typeof params.variant !== "string") return undefined
  if (params.reasoningEffort !== undefined && typeof params.reasoningEffort !== "string") return undefined
  const instructions = instructionParams(params)
  const mcp = mcpParams(params)
  if (!instructions) return undefined
  if (!mcp) return undefined
  return {
    cwd: params.cwd,
    sessionId: params.sessionId,
    provider: params.provider,
    model: params.model,
    variant: params.variant,
    reasoningEffort: params.reasoningEffort,
    ...instructions,
    ...mcp,
  }
}

function sessionListParams(value: unknown): SessionListParams | undefined {
  const params = paramsObject(value)
  if (!params) return undefined
  const limit = params.limit
  const order = params.order
  if (params.cwd !== undefined && typeof params.cwd !== "string") return undefined
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) return undefined
  if (order !== undefined && order !== "asc" && order !== "desc") return undefined
  return {
    cwd: params.cwd,
    limit,
    order,
  }
}

function sessionStatusParams(value: unknown): SessionStatusParams | undefined {
  const params = paramsObject(value)
  if (!params) return undefined
  const sessionId = firstString(params.sessionId, params.providerSessionId, params.threadId)
  if (!sessionId) return undefined
  return { sessionId }
}

function sessionResumeParams(value: unknown): SessionResumeParams | undefined {
  const params = paramsObject(value)
  if (!params) return undefined
  const sessionId = firstString(params.sessionId, params.providerSessionId, params.threadId)
  if (!sessionId) return undefined
  if (params.provider !== undefined && typeof params.provider !== "string") return undefined
  if (params.model !== undefined && typeof params.model !== "string") return undefined
  if (params.variant !== undefined && typeof params.variant !== "string") return undefined
  if (params.reasoningEffort !== undefined && typeof params.reasoningEffort !== "string") return undefined
  const instructions = instructionParams(params)
  const mcp = mcpParams(params)
  if (!instructions) return undefined
  if (!mcp) return undefined
  return {
    sessionId,
    provider: params.provider,
    model: params.model,
    variant: params.variant,
    reasoningEffort: params.reasoningEffort,
    ...instructions,
    ...mcp,
  }
}

function turnStartParams(value: unknown): TurnStartParams | undefined {
  const params = paramsObject(value)
  if (!params) return undefined
  const sessionId = firstString(params.sessionId, params.providerSessionId, params.threadId, params.sessionName)
  if (!sessionId) return undefined
  if (typeof params.prompt !== "string" || params.prompt.trim() === "") return undefined
  if (params.turnId !== undefined && typeof params.turnId !== "string") return undefined
  if (params.messageId !== undefined && typeof params.messageId !== "string") return undefined
  if (params.delivery !== undefined && params.delivery !== "steer" && params.delivery !== "queue") return undefined
  if (params.provider !== undefined && typeof params.provider !== "string") return undefined
  if (params.model !== undefined && typeof params.model !== "string") return undefined
  if (params.variant !== undefined && typeof params.variant !== "string") return undefined
  if (params.reasoningEffort !== undefined && typeof params.reasoningEffort !== "string") return undefined
  const instructions = instructionParams(params)
  const mcp = mcpParams(params)
  if (!instructions) return undefined
  if (!mcp) return undefined
  return {
    sessionId,
    turnId: params.turnId,
    messageId: params.messageId,
    prompt: params.prompt,
    delivery: params.delivery,
    provider: params.provider,
    model: params.model,
    variant: params.variant,
    reasoningEffort: params.reasoningEffort,
    ...instructions,
    ...mcp,
  }
}

function mcpParams(params: Record<string, unknown>): McpParams | undefined {
  const value = params.mcpServers ?? params.mcp_servers
  if (value === undefined) return {}
  const source = paramsObject(value)
  if (!source) return undefined
  const entries = Object.entries(source).map(([name, server]) => [name, mcpServerConfig(server)] as const)
  if (entries.some((entry) => entry[1] === undefined)) return undefined
  return {
    mcpServers: Object.fromEntries(entries) as Record<string, McpServerConfig>,
  }
}

function mcpServerConfig(value: unknown): McpServerConfig | undefined {
  const params = paramsObject(value)
  if (!params) return undefined
  const type = params.type
  const timeout = optionalPositiveInteger(params.timeout)
  if (params.timeout !== undefined && timeout === undefined) return undefined
  if (params.disabled !== undefined && typeof params.disabled !== "boolean") return undefined
  if (type === "remote") {
    if (typeof params.url !== "string" || !URL.canParse(params.url)) return undefined
    if (
      params.transport !== undefined &&
      params.transport !== "streamable-http" &&
      params.transport !== "streamable_http" &&
      params.transport !== "sse"
    ) {
      return undefined
    }
    const headers = optionalStringRecord(params.headers)
    if (params.headers !== undefined && !headers) return undefined
    return {
      type,
      url: params.url,
      ...(headers ? { headers } : {}),
      ...(params.transport === "sse"
        ? { transport: "sse" as const }
        : params.transport === "streamable-http" || params.transport === "streamable_http"
          ? { transport: "streamable-http" as const }
          : {}),
      ...(params.disabled === undefined ? {} : { disabled: params.disabled }),
      ...(timeout === undefined ? {} : { timeout }),
    }
  }
  if (type === "local") {
    if (!Array.isArray(params.command)) return undefined
    const command = params.command.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    if (command.length !== params.command.length || command.length === 0) return undefined
    const environment = optionalStringRecord(params.environment)
    if (params.environment !== undefined && !environment) return undefined
    if (params.cwd !== undefined && typeof params.cwd !== "string") return undefined
    return {
      type,
      command,
      ...(environment ? { environment } : {}),
      ...(typeof params.cwd === "string" && params.cwd.trim() ? { cwd: params.cwd } : {}),
      ...(params.disabled === undefined ? {} : { disabled: params.disabled }),
      ...(timeout === undefined ? {} : { timeout }),
    }
  }
  return undefined
}

function optionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const params = paramsObject(value)
  if (!params) return undefined
  const entries = Object.entries(params)
  if (entries.some((entry) => typeof entry[1] !== "string")) return undefined
  return Object.fromEntries(entries) as Record<string, string>
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined
}

function instructionParams(params: Record<string, unknown>): InstructionParams | undefined {
  if (
    params.builtinInstructions !== undefined &&
    params.builtinInstructions !== "app-server" &&
    params.builtinInstructions !== "none"
  ) {
    return undefined
  }
  if (params.hostPlatform !== undefined && typeof params.hostPlatform !== "string") return undefined
  const developerInstructions = instructionEntries(params.developerInstructions)
  const userDeveloperInstructions = instructionEntries(params.userDeveloperInstructions)
  if (!developerInstructions || !userDeveloperInstructions) return undefined
  return {
    hostPlatform: params.hostPlatform,
    builtinInstructions: params.builtinInstructions,
    developerInstructions,
    userDeveloperInstructions,
  }
}

function instructionEntries(value: unknown): readonly InstructionEntry[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const entries = value.map(instructionEntry)
  return entries.every((entry): entry is InstructionEntry => entry !== undefined) ? entries : undefined
}

function instructionEntry(value: unknown): InstructionEntry | undefined {
  const entry = paramsObject(value)
  if (!entry) return undefined
  if (typeof entry.id !== "string" || entry.id.trim() === "") return undefined
  if (typeof entry.text !== "string" || entry.text.trim() === "") return undefined
  return { id: entry.id.trim(), text: entry.text.trim() }
}

function turnCancelParams(value: unknown): TurnCancelParams | undefined {
  const params = paramsObject(value)
  if (!params) return undefined
  const sessionId = firstString(params.sessionId, params.providerSessionId, params.threadId)
  if (!sessionId) return undefined
  if (params.turnId !== undefined && typeof params.turnId !== "string") return undefined
  return {
    sessionId,
    turnId: params.turnId,
  }
}

function toolApprovalRespondParams(value: unknown): ToolApprovalRespondParams | undefined {
  const params = paramsObject(value)
  if (!params) return undefined
  const sessionId = firstString(params.sessionId, params.providerSessionId, params.threadId)
  const requestId = firstString(params.requestId, params.approvalId, params.permissionId)
  const reply = permissionReplyValue(params.reply, params.decision, params.accepted)
  if (!sessionId || !requestId || !reply) return undefined
  if (params.message !== undefined && typeof params.message !== "string") return undefined
  return {
    sessionId,
    requestId,
    reply,
    message: params.message,
  }
}

function userInputRespondParams(value: unknown): UserInputRespondParams | undefined {
  const params = paramsObject(value)
  if (!params) return undefined
  const sessionId = firstString(params.sessionId, params.providerSessionId, params.threadId)
  const requestId = firstString(params.requestId, params.questionId, params.userInputId)
  const answers = answersValue(params.answers)
  if (!sessionId || !requestId || !answers) return undefined
  return { sessionId, requestId, answers }
}

function userInputRejectParams(value: unknown): UserInputRejectParams | undefined {
  const params = paramsObject(value)
  if (!params) return undefined
  const sessionId = firstString(params.sessionId, params.providerSessionId, params.threadId)
  const requestId = firstString(params.requestId, params.questionId, params.userInputId)
  if (!sessionId || !requestId) return undefined
  return { sessionId, requestId }
}

function permissionReplyValue(...values: unknown[]): PermissionV2.Reply | undefined {
  for (const value of values) {
    if (value === "once" || value === "allow_once" || value === "accept" || value === "accepted") return "once"
    if (value === "always" || value === "allow_always" || value === "accept_always") return "always"
    if (value === "reject" || value === "rejected" || value === "deny" || value === false) return "reject"
    if (value === true) return "once"
  }
  return undefined
}

function initializeResult(): ServerInitializeResult {
  return {
    serverName: "opencode-app-server",
    protocolVersion: ProtocolVersion,
    capabilities: {
      sessions: true,
      resume: true,
      turns: true,
      cancellation: true,
      tools: false,
      models: true,
      providers: true,
      approvals: true,
      userInput: true,
      mcp: true,
    },
  }
}

function sessionCreateResult(session: Session.Info, params: SessionCreateParams): SessionCreateResult {
  void params
  return {
    ...sessionInfo(session),
  }
}

function sessionStatusResult(session: Session.Info): SessionStatusResult {
  return {
    ...sessionInfo(session),
    exists: true,
    active: false,
    busy: false,
    pending: false,
    status: "idle",
  }
}

function sessionResumeResult(session: Session.Info): SessionResumeResult {
  return {
    resumed: true,
    sessionId: session.id,
    providerSessionId: session.id,
    threadId: session.id,
  }
}

function sessionInfo(session: Session.Info): SessionInfo {
  return {
    sessionId: session.id,
    providerSessionId: session.id,
    threadId: session.id,
    cwd: session.location.directory,
    ...(session.model ? modelFields(session.model) : {}),
    title: session.title,
    createdAt: isoDate(session.time.created),
    updatedAt: isoDate(session.time.updated),
  }
}

function turnCancelResult(session: Session.Info, active: ActiveTurn | undefined): TurnCancelResult {
  return {
    cancelled: true,
    active: active !== undefined,
    sessionId: session.id,
    providerSessionId: session.id,
    threadId: session.id,
    ...(active ? { turnId: active.turnId } : {}),
  }
}

function toolApprovalRespondResult(
  session: Session.Info,
  params: ToolApprovalRespondParams,
): ToolApprovalRespondResult {
  return {
    ok: true,
    sessionId: session.id,
    providerSessionId: session.id,
    threadId: session.id,
    requestId: params.requestId,
    approvalId: params.requestId,
    reply: params.reply,
  }
}

function userInputRespondResult(session: Session.Info, params: UserInputRespondParams): UserInputRespondResult {
  return {
    ok: true,
    sessionId: session.id,
    providerSessionId: session.id,
    threadId: session.id,
    requestId: params.requestId,
    answers: params.answers,
  }
}

function userInputRejectResult(session: Session.Info, params: UserInputRejectParams): UserInputRejectResult {
  return {
    ok: true,
    rejected: true,
    sessionId: session.id,
    providerSessionId: session.id,
    threadId: session.id,
    requestId: params.requestId,
  }
}

function isoDate(value: DateTime.Utc) {
  return new Date(DateTime.toEpochMillis(value)).toISOString()
}

export function turnNotifications(activeTurns: Map<string, ActiveTurn>, event: EventV2.Payload): JsonRpcNotification[] {
  const data = record(event.data)
  const sessionId = stringValue(data.sessionID)
  if (!sessionId) return []
  const turn = activeTurns.get(sessionId)
  if (!turn) return []

  if (event.type === "session.error") {
    return turnFailureNotifications(activeTurns, sessionId, data.error ?? { type: "unknown", message: "Session failed." })
  }

  if (event.type === "session.next.interrupt.requested") {
    void cleanupActiveTurn(activeTurns, sessionId)
    return [
      notification("turn/completed", {
        ...turnBase(turn),
        status: "cancelled",
        content: turn.content.join(""),
        reasoning: turn.reasoning.join(""),
      }),
    ]
  }

  if (event.type === "permission.v2.asked") {
    const source = record(data.source)
    return [
      notification("turn/toolApprovalRequested", {
        ...turnBase(turn),
        approvalId: stringValue(data.id),
        requestId: stringValue(data.id),
        permission: stringValue(data.action),
        action: stringValue(data.action),
        resources: stringArrayValue(data.resources),
        save: stringArrayValue(data.save),
        metadata: record(data.metadata),
        source: data.source,
        toolCallId: stringValue(source.callID),
        messageId: stringValue(source.messageID),
        options: ["once", "always", "reject"],
      }),
    ]
  }

  if (event.type === "permission.v2.replied") {
    return [
      notification("turn/toolApprovalResolved", {
        ...turnBase(turn),
        approvalId: stringValue(data.requestID),
        requestId: stringValue(data.requestID),
        reply: stringValue(data.reply),
      }),
    ]
  }

  if (event.type === "question.v2.asked") {
    const tool = record(data.tool)
    return [
      notification("turn/userInputRequested", {
        ...turnBase(turn),
        requestId: stringValue(data.id),
        questionId: stringValue(data.id),
        questions: data.questions,
        tool: data.tool,
        toolCallId: stringValue(tool.callID),
        messageId: stringValue(tool.messageID),
      }),
    ]
  }

  if (event.type === "question.v2.replied") {
    return [
      notification("turn/userInputResolved", {
        ...turnBase(turn),
        requestId: stringValue(data.requestID),
        questionId: stringValue(data.requestID),
        status: "answered",
        answers: data.answers,
      }),
    ]
  }

  if (event.type === "question.v2.rejected") {
    return [
      notification("turn/userInputResolved", {
        ...turnBase(turn),
        requestId: stringValue(data.requestID),
        questionId: stringValue(data.requestID),
        status: "rejected",
      }),
    ]
  }

  if (event.type === "session.next.step.started") {
    return [
      notification("turn/started", {
        ...turnBase(turn),
        messageId: stringValue(data.assistantMessageID),
      }).params,
      notification("turn/modelInfo", {
        ...turnBase(turn),
        model: modelPayload(data.model, turn.contextWindow),
      }).params,
    ].map((params, index) => notification(index === 0 ? "turn/started" : "turn/modelInfo", params))
  }

  if (event.type === "session.next.text.delta") {
    const delta = stringValue(data.delta)
    if (!delta) return []
    turn.content.push(delta)
    return [notification("turn/contentDelta", { ...turnBase(turn), delta, textId: stringValue(data.textID) })]
  }

  if (event.type === "session.next.reasoning.delta") {
    const delta = stringValue(data.delta)
    if (!delta) return []
    turn.reasoning.push(delta)
    return [
      notification("turn/thoughtDelta", {
        ...turnBase(turn),
        delta,
        reasoningId: stringValue(data.reasoningID),
      }),
    ]
  }

  if (event.type === "session.next.tool.called") {
    return [
      notification("turn/toolCallRequested", {
        ...turnBase(turn),
        toolCallId: stringValue(data.callID),
        messageId: stringValue(data.assistantMessageID),
        tool: stringValue(data.tool),
        input: data.input,
        provider: data.provider,
      }),
    ]
  }

  if (event.type === "session.next.tool.success") {
    return [
      notification("turn/toolCallCompleted", {
        ...turnBase(turn),
        status: "completed",
        toolCallId: stringValue(data.callID),
        messageId: stringValue(data.assistantMessageID),
        structured: data.structured,
        content: data.content,
        outputPaths: data.outputPaths,
        result: data.result,
        provider: data.provider,
      }),
    ]
  }

  if (event.type === "session.next.tool.failed") {
    return [
      notification("turn/toolCallCompleted", {
        ...turnBase(turn),
        status: "failed",
        toolCallId: stringValue(data.callID),
        messageId: stringValue(data.assistantMessageID),
        error: data.error,
        result: data.result,
        provider: data.provider,
      }),
    ]
  }

  if (event.type === "session.next.step.failed") {
    void cleanupActiveTurn(activeTurns, sessionId)
    return [
      notification("turn/error", { ...turnBase(turn), error: data.error }),
      notification("turn/completed", {
        ...turnBase(turn),
        status: "failed",
        content: turn.content.join(""),
        reasoning: turn.reasoning.join(""),
        error: data.error,
      }),
    ]
  }

  if (event.type === "session.next.step.ended") {
    if (data.finish === "tool-calls") return []
    void cleanupActiveTurn(activeTurns, sessionId)
    const usage = tokenUsage(data.tokens, turn.contextWindow)
    return [
      notification("turn/completed", {
        ...turnBase(turn),
        status: "completed",
        content: turn.content.join(""),
        reasoning: turn.reasoning.join(""),
        finish: data.finish,
        cost: data.cost,
        tokens: data.tokens,
        ...(usage ? { usage } : {}),
        ...(turn.contextWindow === undefined
          ? {}
          : {
              contextWindow: turn.contextWindow,
              context_window: turn.contextWindow,
            }),
      }),
    ]
  }

  return []
}

function turnFailureNotifications(
  activeTurns: Map<string, ActiveTurn>,
  sessionId: string,
  eventError: unknown,
): JsonRpcNotification[] {
  const turn = activeTurns.get(sessionId)
  if (!turn) return []
  void cleanupActiveTurn(activeTurns, sessionId)
  return [
    notification("turn/error", { ...turnBase(turn), error: eventError }),
    notification("turn/completed", {
      ...turnBase(turn),
      status: "failed",
      content: turn.content.join(""),
      reasoning: turn.reasoning.join(""),
      error: eventError,
    }),
  ]
}

async function cleanupActiveTurn(activeTurns: Map<string, ActiveTurn>, sessionId: string) {
  const turn = activeTurns.get(sessionId)
  activeTurns.delete(sessionId)
  await turn?.cleanup?.()
}

function turnBase(turn: ActiveTurn) {
  return {
    turnId: turn.turnId,
    sessionId: turn.sessionId,
    providerSessionId: turn.sessionId,
    threadId: turn.sessionId,
  }
}

function modelPayload(value: unknown, contextWindow?: number) {
  const model = record(value)
  const providerID = stringValue(model.providerID)
  const id = stringValue(model.id)
  return {
    provider: providerID,
    providerID,
    model: id,
    modelID: id,
    ...(stringValue(model.variant) ? { variant: stringValue(model.variant) } : {}),
    ...(contextWindow === undefined
      ? {}
      : {
          contextWindow,
          context_window: contextWindow,
        }),
  }
}

function tokenUsage(value: unknown, contextWindow?: number) {
  const tokens = record(value)
  const cache = record(tokens.cache)
  const input = numberValue(tokens.input)
  const output = numberValue(tokens.output)
  const reasoning = numberValue(tokens.reasoning)
  const cacheRead = numberValue(cache.read)
  const cacheWrite = numberValue(cache.write)
  const total = numberValue(tokens.total) ?? sumNumbers(input, output, reasoning, cacheRead, cacheWrite)
  const contextUsed = sumNumbers(input, cacheRead, cacheWrite)
  if (total === undefined && contextUsed === undefined) return undefined
  return {
    ...(total === undefined ? {} : { total }),
    ...(input === undefined ? {} : { input, inputTokens: input, input_tokens: input }),
    ...(output === undefined ? {} : { output, outputTokens: output, output_tokens: output }),
    ...(reasoning === undefined ? {} : { reasoning, reasoningTokens: reasoning, reasoning_tokens: reasoning }),
    ...(cacheRead === undefined ? {} : { cacheRead, cache_read: cacheRead, cachedInputTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite, cache_write: cacheWrite }),
    ...(contextUsed === undefined ? {} : { contextUsed, context_used: contextUsed }),
    ...(contextWindow === undefined ? {} : { contextWindow, context_window: contextWindow }),
    ...(contextUsed === undefined || contextWindow === undefined || contextWindow <= 0
      ? {}
      : { contextPercent: contextUsed / contextWindow, context_percent: contextUsed / contextWindow }),
  }
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim() !== "")
}

function createSessionID(value: string) {
  return parseSessionID(value, -32602, `Invalid session id: ${value}`)
}

function loadedSessionID(value: string) {
  return parseSessionID(value, -32010, `Session not loaded: ${value}`)
}

function questionRequestID(value: string) {
  try {
    return QuestionV2.ID.make(value)
  } catch {
    throw new AppServerError(-32602, `Invalid question request id: ${value}`)
  }
}

function parseSessionID(value: string, code: number, message: string) {
  try {
    return Session.ID.make(value)
  } catch {
    throw new AppServerError(code, message)
  }
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function positiveNumber(value: unknown) {
  const number = numberValue(value)
  return number === undefined || number <= 0 ? undefined : number
}

function sumNumbers(...values: Array<number | undefined>) {
  const numbers = values.filter((value): value is number => value !== undefined)
  if (numbers.length === 0) return undefined
  return numbers.reduce((total, value) => total + value, 0)
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function answersValue(value: unknown): readonly (readonly string[])[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map((answer) => (Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : undefined))
    .every((answer): answer is string[] => answer !== undefined)
    ? value.map((answer) => (answer as unknown[]).filter((item): item is string => typeof item === "string"))
    : undefined
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  return {}
}

function modelRef(params: ModelSelectionParams): Model.Ref | undefined {
  if (!params.model) return undefined
  const providerID = params.provider ?? params.model.split("/")[0]
  const modelID =
    params.provider && params.model.startsWith(`${params.provider}/`)
      ? params.model.slice(params.provider.length + 1)
      : params.provider
        ? params.model
        : params.model.slice(providerID.length + 1)
  if (!providerID || !modelID) throw new Error("Invalid session model selection.")
  const variant = stringValue(params.variant) ?? stringValue(params.reasoningEffort)
  return Schema.decodeUnknownSync(Model.Ref)({
    providerID,
    id: modelID,
    ...(variant && variant !== "default" ? { variant } : {}),
  })
}

function instructionModelRef(
  locations: LocationServices,
  location: Location.Ref,
  model: Model.Ref | undefined,
) {
  if (model) return Effect.succeed(model)
  return Effect.gen(function* () {
    yield* (yield* PluginBoot.Service).wait()
    const catalog = yield* Catalog.Service
    const selected = Option.getOrUndefined(yield* catalog.model.default())
    if (!selected) return undefined
    return Schema.decodeUnknownSync(Model.Ref)({
      providerID: selected.providerID,
      id: selected.id,
    })
  }).pipe(Effect.provide(locations.get(location)))
}

function applyInstructionOverlay(
  params: InstructionParams,
  session: Session.Info,
  model: Model.Ref | undefined,
  locations: LocationServices,
) {
  return SessionInstructionOverlay.Service.use((service) =>
    service.set(session.id, {
      ...(params.builtinInstructions === "none"
        ? {}
        : { builtin: { id: "opencode-app-server", text: appServerBuiltinPrompt(model, params.hostPlatform) } }),
      developer: params.developerInstructions,
      userDeveloper: params.userDeveloperInstructions,
    }),
  ).pipe(Effect.provide(locations.get(session.location)))
}

function appServerBuiltinPrompt(model: Model.Ref | undefined, hostPlatform: string | undefined) {
  const modelID = model ? `${model.providerID}/${model.id}${model.variant ? `/${model.variant}` : ""}` : undefined
  const platform = hostPlatform?.trim() ? `the ${hostPlatform.trim()} platform` : "an app-server host platform"
  return [
    `You are OpenCode running through ${platform}.`,
    "You and the user share the same workspace. Help with software engineering tasks by reading the codebase first, making concrete changes when asked, and keeping responses concise and factual.",
    "Do not describe yourself as an interactive CLI or TUI agent unless the user specifically asks about the underlying OpenCode binary or launch mode.",
    modelID
      ? `The selected model for this session is ${modelID}. If the user asks which model you are, report this exact model ID and do not infer a training lab, creator, or corporate identity from unrelated context.`
      : "No model has been selected for this session yet. If the user asks which model you are before a model is selected, say that no model is currently selected.",
  ].join("\n")
}

function resolveCwd(cwd: string) {
  const resolved = fs.realpathSync(cwd)
  if (!fs.statSync(resolved).isDirectory()) throw new Error("Session cwd is not a directory.")
  return resolved
}

function discoverableProvider(provider: ProviderV2.Info) {
  return Boolean(provider.enabled) || provider.id === ProviderV2.ID.opencode
}

function discoverableModels(providers: readonly ProviderV2.Info[], models: readonly ModelV2.Info[]) {
  const providerIDs = new Set(providers.map((provider) => provider.id))
  return models.filter((model) => model.enabled && providerIDs.has(model.providerID))
}

function providerListResult(
  providers: readonly ProviderV2.Info[],
  models: readonly ModelV2.Info[],
  defaultModel: Option.Option<ModelV2.Info>,
): ProviderListResult {
  return {
    data: providers
      .map((provider) => providerInfo(provider, models, Option.getOrUndefined(defaultModel)))
      .sort((a, b) => a.id.localeCompare(b.id)),
    ...(Option.isSome(defaultModel) ? { default: defaultModel.value.providerID } : {}),
  }
}

function providerInfo(
  provider: ProviderV2.Info,
  models: readonly ModelV2.Info[],
  defaultModel: ModelV2.Info | undefined,
): ProviderInfo {
  const providerModels = models.filter((model) => model.providerID === provider.id)
  const defaultProviderModel =
    defaultModel?.providerID === provider.id
      ? defaultModel.id
      : [...providerModels].sort((a, b) => a.id.localeCompare(b.id))[0]?.id
  return {
    id: provider.id,
    value: provider.id,
    name: provider.name,
    label: provider.name,
    displayName: provider.name,
    ...(defaultProviderModel ? { defaultModel: defaultProviderModel } : {}),
    source: "catalog",
    capabilities: {
      source: "catalog",
      modelCount: providerModels.length,
      env: provider.env,
      enabled: provider.enabled,
      api: provider.api,
    },
  }
}

function modelListResult(
  providers: readonly ProviderV2.Info[],
  models: readonly ModelV2.Info[],
  defaultModel: Option.Option<ModelV2.Info>,
  params: ModelListParams,
  runtimeVariants: RuntimeVariantIndex,
): ModelListResult {
  const providerByID = new Map(providers.map((provider) => [provider.id, provider]))
  return {
    data: models
      .filter((model) => !params.provider || model.providerID === params.provider)
      .map((model) => modelInfo(providerByID.get(model.providerID), model, runtimeVariants))
      .sort((a, b) => a.id.localeCompare(b.id)),
    ...(Option.isSome(defaultModel) && (!params.provider || defaultModel.value.providerID === params.provider)
      ? { default: `${defaultModel.value.providerID}/${defaultModel.value.id}` }
      : {}),
  }
}

function modelVariantListResult(
  models: readonly ModelV2.Info[],
  params: ModelVariantListParams,
  runtimeVariants: RuntimeVariantIndex,
): ModelVariantListResult {
  const selected = modelSelection(params.provider, params.model)
  const model = models.find(
    (item) =>
      (!selected.providerID || item.providerID === selected.providerID) &&
      (!selected.modelID || item.id === selected.modelID) &&
      (selected.providerID !== undefined || selected.modelID !== undefined),
  )
  const variants = model ? modelVariants(model, runtimeVariants) : []
  return {
    data: variants,
    default: variants[0]?.value ?? "",
  }
}

function modelInfo(
  provider: ProviderV2.Info | undefined,
  model: ModelV2.Info,
  runtimeVariants: RuntimeVariantIndex,
): ModelInfo {
  const providerName = provider?.name ?? model.providerID
  const variants = modelVariants(model, runtimeVariants)
  const thinking = variants.length > 0 || model.capabilities.output.some((item) => item.includes("reasoning"))
  return {
    id: `${model.providerID}/${model.id}`,
    value: `${model.providerID}/${model.id}`,
    provider: model.providerID,
    providerID: model.providerID,
    model: model.id,
    modelID: model.id,
    name: model.name,
    label: `${model.name} (${providerName})`,
    displayName: model.name,
    family: model.family ?? model.providerID,
    supported_reasoning_efforts: variants,
    supportedReasoningEfforts: variants,
    default_reasoning_effort: variants[0]?.value ?? "",
    defaultReasoningEffort: variants[0]?.value ?? "",
    features: {
      thinking,
      multimodalToolUse: model.capabilities.input.some((item) => !item.startsWith("text")),
    },
    capabilities: {
      providerID: model.providerID,
      modelID: model.id,
      status: model.status,
      context: model.limit.context,
      input: model.limit.input,
      output: model.limit.output,
      tools: model.capabilities.tools,
      modalities: model.capabilities.input,
      outputModalities: model.capabilities.output,
      reasoning: thinking,
      api: model.api,
      variants: variants.map((variant) => variant.id),
      cost: model.cost,
    },
  }
}

function runtimeVariantIndexEffect() {
  return ModelsDev.Service.use((service) => service.get()).pipe(
    Effect.map(runtimeVariantIndex),
    Effect.provide(ModelsDev.defaultLayer),
  )
}

function runtimeVariantIndex(data: Record<string, ModelsDev.Provider>): RuntimeVariantIndex {
  const result = new Map<string, Record<string, Record<string, unknown>>>()
  for (const provider of Object.values(data)) {
    const runtimeProvider = Provider.fromModelsDevProvider(provider)
    for (const model of Object.values(runtimeProvider.models)) {
      if (model.variants && Object.keys(model.variants).length > 0) {
        result.set(modelKey(runtimeProvider.id, model.id), model.variants)
      }
    }
  }
  return result
}

function modelVariants(model: ModelV2.Info, runtimeVariants: RuntimeVariantIndex): ModelVariantInfo[] {
  const result = new Map<string, ModelVariantInfo>()
  for (const [id, request] of Object.entries(runtimeVariants.get(modelKey(model.providerID, model.id)) ?? {})) {
    result.set(id, runtimeVariantInfo(id, request))
  }
  for (const variant of model.variants) {
    const request = {
      headers: { ...variant.headers },
      body: { ...variant.body },
      generation: { ...variant.generation },
      options: { ...variant.options },
    }
    result.set(variant.id, {
      id: variant.id,
      value: variant.id,
      label: variant.id,
      variant: variant.id,
      reasoningEffort: variant.id,
      ...request,
      request,
      raw: {
        id: variant.id,
        ...request,
      },
    })
  }
  return [...result.values()]
}

function runtimeVariantInfo(id: string, request: Record<string, unknown>): ModelVariantInfo {
  const headers = stringRecord(request.headers)
  const body = objectRecord(request.body)
  const generation = objectRecord(request.generation)
  const options = Object.fromEntries(
    Object.entries(request).filter(([key]) => key !== "headers" && key !== "body" && key !== "generation"),
  )
  return {
    id,
    value: id,
    label: id,
    variant: id,
    reasoningEffort: id,
    headers,
    body,
    generation,
    options,
    request: {
      headers,
      body,
      generation,
      options,
    },
    raw: {
      id,
      ...request,
    },
  }
}

function modelKey(providerID: string, modelID: string) {
  return `${providerID}/${modelID}`
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function modelSelection(provider: string | undefined, model: string | undefined) {
  if (!model) return { providerID: provider, modelID: undefined }
  if (provider && model.startsWith(`${provider}/`)) {
    return { providerID: provider, modelID: model.slice(provider.length + 1) }
  }
  if (provider) return { providerID: provider, modelID: model }
  const providerID = model.split("/")[0]
  return { providerID, modelID: model.slice(providerID.length + 1) }
}

function modelFields(model: Model.Ref) {
  return {
    provider: model.providerID,
    model: model.id,
    ...(model.variant ? { variant: model.variant } : {}),
  }
}

function result(id: JsonRpcID, value: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: value }
}

function notification(method: string, params: Record<string, unknown>): JsonRpcNotification {
  return { jsonrpc: "2.0", method, params }
}

function error(id: JsonRpcID, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

function errorDetails(method: string, cause: unknown) {
  const tagged = taggedError(cause)
  if (tagged) {
    return {
      message: `${method} failed: ${tagged.tag}${tagged.details ? ` ${tagged.details}` : ""}`,
      data: { method, cause: tagged.data },
    }
  }
  if (cause instanceof Error && cause.message) {
    return { message: `${method} failed: ${cause.message}`, data: { method, cause: cause.name } }
  }
  const text = stringifyUnknown(cause)
  return {
    message: `${method} failed: ${text || Object.prototype.toString.call(cause)}`,
    data: { method, cause: text },
  }
}

function taggedError(cause: unknown) {
  const value = objectRecord(cause)
  const tag = stringValue(value._tag)
  if (!tag) return undefined
  const details = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "_tag" && key !== "_id"))
  return {
    tag,
    details: stringifyUnknown(details),
    data: {
      tag,
      details,
    },
  }
}

function stringifyUnknown(value: unknown) {
  if (typeof value === "string") return value
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function causeError(cause: Cause.Cause<unknown>) {
  return new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject()
}

function jsonRpcWriter() {
  let pending = Promise.resolve()
  return {
    write(message: JsonRpcMessage) {
      pending = pending.then(() => writeJsonRpcMessage(message), () => writeJsonRpcMessage(message))
      return pending
    },
  }
}

function writeJsonRpcMessage(message: JsonRpcMessage) {
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify(message) + EOL, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}
