import { createInterface } from "node:readline"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import { EOL } from "os"
import { Effect } from "effect"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { effectCmd } from "../effect-cmd"
import { Identifier } from "../../id/id"

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
type PermissionReply = "once" | "always" | "reject"

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
    readonly mcp: false
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

type SessionMessagesParams = {
  readonly sessionId: string
  readonly limit?: number
  readonly order?: "asc" | "desc"
  readonly cursor?: {
    readonly id: string
    readonly direction: "previous" | "next"
  }
}

type SessionMessagesResult = {
  readonly sessionId: string
  readonly providerSessionId: string
  readonly threadId: string
  readonly data: readonly unknown[]
  readonly messages: readonly unknown[]
  readonly cursor?: {
    readonly id: string
    readonly direction: "previous"
  }
  readonly nextCursor?: string
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
  readonly reply: PermissionReply
  readonly message?: string
}

type ToolApprovalRespondResult = {
  readonly ok: true
  readonly sessionId: string
  readonly providerSessionId: string
  readonly threadId: string
  readonly requestId: string
  readonly approvalId: string
  readonly reply: PermissionReply
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
  readonly sessionMessages?: (params: SessionMessagesParams) => Promise<SessionMessagesResult>
  readonly getSessionStatus: (params: SessionStatusParams) => Promise<SessionStatusResult>
  readonly resumeSession: (params: SessionResumeParams) => Promise<SessionResumeResult>
  readonly startTurn: (params: TurnStartParams, emit: NotificationEmitter) => Promise<TurnStartResult>
  readonly cancelTurn: (params: TurnCancelParams) => Promise<TurnCancelResult>
  readonly respondToolApproval: (params: ToolApprovalRespondParams) => Promise<ToolApprovalRespondResult>
  readonly respondUserInput: (params: UserInputRespondParams) => Promise<UserInputRespondResult>
  readonly rejectUserInput: (params: UserInputRejectParams) => Promise<UserInputRejectResult>
  readonly dispose?: () => Promise<void>
}

export type ActiveTurn = {
  readonly turnId: string
  readonly sessionId: string
  readonly content: string[]
  readonly reasoning: string[]
  partLengths?: Map<string, number>
  partTypes?: Map<string, string>
  toolStates?: Map<string, string>
  assistantMessageIds?: Set<string>
  started?: boolean
  cancelRequested?: boolean
  readonly contextWindow?: number
  readonly cleanup?: NotificationCleanup
}

type RouteClient = ReturnType<typeof createOpencodeClient>

type RouteSession = {
  readonly id: string
  readonly directory: string
  readonly title: string
  readonly model?: {
    readonly id?: string
    readonly modelID?: string
    readonly providerID?: string
    readonly variant?: string
  }
  readonly time: {
    readonly created: number
    readonly updated: number
  }
}

type RouteProviderList = {
  readonly all: readonly RouteProvider[]
  readonly default?: Record<string, string>
  readonly connected?: readonly string[]
}

type RouteConfigProviderList = {
  readonly providers: readonly RouteProvider[]
  readonly default?: Record<string, string>
}

type RouteProvider = {
  readonly id: string
  readonly name: string
  readonly source: string
  readonly env?: readonly string[]
  readonly models?: Record<string, RouteModel>
  readonly options?: Record<string, unknown>
}

type RouteModel = {
  readonly id: string
  readonly providerID: string
  readonly api?: Record<string, unknown>
  readonly name: string
  readonly family?: string
  readonly capabilities?: {
    readonly reasoning?: boolean
    readonly attachment?: boolean
    readonly toolcall?: boolean
    readonly input?: Record<string, boolean>
    readonly output?: Record<string, boolean>
    readonly interleaved?: boolean | Record<string, unknown>
  }
  readonly cost?: unknown
  readonly limit?: {
    readonly context?: number
    readonly input?: number
    readonly output?: number
  }
  readonly status?: string
  readonly variants?: Record<string, Record<string, unknown>>
}

type RouteModelSelection = {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
}

class AppServerError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

export const AppServerCommand = effectCmd({
  command: "app-server",
  describe: "start stdio JSON-RPC app server",
  instance: false,
  handler: Effect.fn("Cli.appServer")(function* () {
    routeConsoleToStderr()
    const routeClient = createRouteClient()
    const activeTurns = new Map<string, ActiveTurn>()
    const eventControllers = new Map<string, AbortController>()
    const ensureEventLoop = (cwd: string, emit: NotificationEmitter) => {
      if (eventControllers.has(cwd)) return
      const controller = new AbortController()
      eventControllers.set(cwd, controller)
      void routeEventLoop(routeClient, cwd, controller.signal, activeTurns, emit)
        .catch((cause) => {
          if (!controller.signal.aborted) console.error(errorDetails("event.subscribe", cause).message)
        })
        .finally(() => {
          if (eventControllers.get(cwd) === controller) eventControllers.delete(cwd)
        })
    }
    const dispose = async () => {
      for (const controller of eventControllers.values()) {
        controller.abort()
      }
      eventControllers.clear()
      await cleanupAllActiveTurns(activeTurns)
    }
    yield* Effect.promise(() =>
      runAppServer({
        listProviders: async (params) =>
          routeProviderListResult(await routeProviderCatalog(routeClient, params.cwd)),
        listModels: async (params) =>
          routeModelListResult(
            await routeProviderCatalog(routeClient, params.cwd),
            params,
          ),
        listModelVariants: async (params) =>
          routeModelVariantListResult(
            await routeProviderCatalog(routeClient, params.cwd),
            params,
          ),
        createSession: async (params) => {
          assertRouteSupportedParams(params)
          const cwd = resolveCwd(params.cwd)
          const selectedModel = routeModelSelection(params)
          if (selectedModel) {
            routeRequireModelSelection(await routeProviderCatalog(routeClient, cwd), selectedModel)
          }
          const session = params.sessionId
            ? await routeData<RouteSession>(
                "session.get",
                routeClient.session.get({ sessionID: params.sessionId, directory: cwd }),
                { notFound: new AppServerError(-32010, `Session not found: ${params.sessionId}`) },
              )
            : await routeData<RouteSession>(
                "session.create",
                routeClient.session.create({
                  directory: cwd,
                  model: routeCreateModel(selectedModel),
                }),
              )
          return routeSessionCreateResult(session)
        },
        listSessions: async (params) => {
          if (params.order !== undefined && params.order !== "desc") {
            throw new AppServerError(-32602, "session/list only supports desc order through the HTTP route.")
          }
          const sessions = await routeData<readonly RouteSession[]>(
            "session.list",
            routeClient.session.list({
              ...routeDirectory(params.cwd),
              ...(params.limit ? { limit: params.limit } : {}),
            }),
          )
          return { data: sessions.map(routeSessionInfo) }
        },
        sessionMessages: (params) =>
          routeSessionMessages(routeClient, params),
        getSessionStatus: async (params) =>
          routeSessionStatusResult(
            await routeData<RouteSession>("session.get", routeClient.session.get({ sessionID: params.sessionId }), {
              notFound: new AppServerError(-32010, `Session not found: ${params.sessionId}`),
            }),
          ),
        resumeSession: async (params) => {
          assertRouteSupportedParams(params)
          const session = await routeData<RouteSession>("session.get", routeClient.session.get({ sessionID: params.sessionId }), {
            notFound: new AppServerError(-32010, `Session not found: ${params.sessionId}`),
          })
          return routeSessionResumeResult(session)
        },
        startTurn: async (params, emit) => {
          assertRouteSupportedParams(params)
          if (params.delivery === "queue") {
            throw new AppServerError(-32602, "turn/start delivery=queue is not supported by the HTTP route.")
          }
          const session = await routeData<RouteSession>("session.get", routeClient.session.get({ sessionID: params.sessionId }), {
            notFound: new AppServerError(-32010, `Session not found: ${params.sessionId}`),
          })
          if (activeTurns.has(session.id)) {
            throw new AppServerError(-32020, `Session already has an active turn: ${session.id}`)
          }
          ensureEventLoop(session.directory, emit)
          const turnId = params.turnId ?? randomUUID()
          const selectedModel = routeModelSelection(params) ?? routeSessionModelSelection(session)
          const providerCatalog = selectedModel ? await routeProviderCatalog(routeClient, session.directory) : undefined
          if (selectedModel && providerCatalog) routeRequireModelSelection(providerCatalog, selectedModel)
          const active: ActiveTurn = {
            turnId,
            sessionId: session.id,
            content: [],
            reasoning: [],
            partLengths: new Map(),
            toolStates: new Map(),
            assistantMessageIds: new Set(),
            started: false,
            ...(selectedModel && providerCatalog
              ? { contextWindow: routeModelContextWindow(providerCatalog, selectedModel) }
              : {}),
          }
          activeTurns.set(session.id, active)
          try {
            const system = routeSystemPrompt(params, selectedModel)
            const messageId = params.messageId ?? Identifier.ascending("message")
            await routeVoid(
              "session.prompt_async",
              routeClient.session.promptAsync({
                sessionID: session.id,
                directory: session.directory,
                messageID: messageId,
                ...(selectedModel ? { model: { providerID: selectedModel.providerID, modelID: selectedModel.modelID } } : {}),
                ...(selectedModel?.variant ? { variant: selectedModel.variant } : {}),
                ...(system ? { system } : {}),
                parts: [{ type: "text", text: params.prompt }],
              }),
              { notFound: new AppServerError(-32010, `Session not found: ${params.sessionId}`) },
            )
            return {
              accepted: true,
              turnId,
              sessionId: session.id,
              providerSessionId: session.id,
              threadId: session.id,
              messageId,
              delivery: "steer",
            }
          } catch (cause) {
            await cleanupActiveTurn(activeTurns, session.id)
            throw cause
          }
        },
        cancelTurn: async (params) => {
          const session = await routeData<RouteSession>("session.get", routeClient.session.get({ sessionID: params.sessionId }), {
            notFound: new AppServerError(-32010, `Session not found: ${params.sessionId}`),
          })
          const active = activeTurns.get(session.id)
          if (params.turnId && active && params.turnId !== active.turnId) {
            throw new AppServerError(-32020, `Session has a different active turn: ${session.id}`)
          }
          if (active) active.cancelRequested = true
          await routeData("session.abort", routeClient.session.abort({ sessionID: session.id, directory: session.directory }), {
            notFound: new AppServerError(-32010, `Session not found: ${params.sessionId}`),
          })
          return routeTurnCancelResult(session, active)
        },
        respondToolApproval: async (params) => {
          const session = await routeData<RouteSession>("session.get", routeClient.session.get({ sessionID: params.sessionId }), {
            notFound: new AppServerError(-32010, `Session not found: ${params.sessionId}`),
          })
          await routeData(
            "permission.reply",
            routeClient.permission.reply({
              requestID: params.requestId,
              directory: session.directory,
              reply: params.reply,
              message: params.message,
            }),
            { notFound: new AppServerError(-32040, `Permission request not found: ${params.requestId}`) },
          )
          return routeToolApprovalRespondResult(session, params)
        },
        respondUserInput: async (params) => {
          const session = await routeData<RouteSession>("session.get", routeClient.session.get({ sessionID: params.sessionId }), {
            notFound: new AppServerError(-32010, `Session not found: ${params.sessionId}`),
          })
          await routeData(
            "question.reply",
            routeClient.question.reply({
              requestID: params.requestId,
              directory: session.directory,
              answers: params.answers.map((answer) => [...answer]),
            }),
            { notFound: new AppServerError(-32050, `Question request not found: ${params.requestId}`) },
          )
          return routeUserInputRespondResult(session, params)
        },
        rejectUserInput: async (params) => {
          const session = await routeData<RouteSession>("session.get", routeClient.session.get({ sessionID: params.sessionId }), {
            notFound: new AppServerError(-32010, `Session not found: ${params.sessionId}`),
          })
          await routeData(
            "question.reject",
            routeClient.question.reject({ requestID: params.requestId, directory: session.directory }),
            { notFound: new AppServerError(-32050, `Question request not found: ${params.requestId}`) },
          )
          return routeUserInputRejectResult(session, params)
        },
        dispose,
      }),
    )
  }),
})

function routeConsoleToStderr() {
  console.log = (...input) => console.error(...input)
  console.info = (...input) => console.error(...input)
  console.debug = (...input) => console.error(...input)
}

function createRouteClient() {
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { Server } = await import("../../server/server")
    return Server.Default().app.fetch(new Request(input, init))
  }) as typeof globalThis.fetch
  return createOpencodeClient({
    baseUrl: "http://opencode.internal",
    fetch: fetchFn,
  })
}

function routeDirectory(cwd: string | undefined) {
  return cwd ? { directory: resolveCwd(cwd) } : {}
}

async function routeData<T>(
  method: string,
  promise: Promise<unknown>,
  options?: { readonly notFound?: AppServerError },
): Promise<T> {
  const response = record(await promise)
  if (response.error !== undefined) throw routeError(method, response.error, options)
  if (!("data" in response)) throw new AppServerError(-32603, `${method} returned no data.`)
  return response.data as T
}

async function routeVoid(
  method: string,
  promise: Promise<unknown>,
  options?: { readonly notFound?: AppServerError },
): Promise<void> {
  const response = record(await promise)
  if (response.error !== undefined) throw routeError(method, response.error, options)
}

function routeError(method: string, value: unknown, options: { readonly notFound?: AppServerError } | undefined) {
  const error = record(value)
  const tag = stringValue(error._tag) ?? stringValue(error.name)
  const data = record(error.data)
  const message = stringValue(error.message) ?? stringValue(data.message) ?? `${method} failed.`
  if (options?.notFound && (tag?.includes("NotFound") || message.toLowerCase().includes("not found"))) {
    return options.notFound
  }
  if (tag === "BadRequest" || tag === "InvalidRequestError") return new AppServerError(-32602, message)
  return new AppServerError(-32603, `${method} failed: ${message}`)
}

function assertRouteSupportedParams(params: McpParams) {
  if (params.mcpServers !== undefined) {
    throw new AppServerError(-32602, "mcpServers are not supported by the HTTP route-backed app-server yet.")
  }
}

async function routeProviderCatalog(client: RouteClient, cwd: string | undefined): Promise<RouteProviderList> {
  const directory = routeDirectory(cwd)
  const source = await routeData<RouteProviderList>("provider.list", client.provider.list(directory))
  const configured = await routeData<RouteConfigProviderList>("config.providers", client.config.providers(directory))
  return routeMergeProviderCatalog(source, configured)
}

function routeMergeProviderCatalog(source: RouteProviderList, configured: RouteConfigProviderList): RouteProviderList {
  const configuredIds = new Set(configured.providers.map((provider) => provider.id))
  const all = [
    ...source.all.filter((provider) => !configuredIds.has(provider.id)),
    ...configured.providers,
  ]
  const defaults = { ...(source.default ?? {}), ...(configured.default ?? {}) }
  return {
    all,
    ...(Object.keys(defaults).length ? { default: defaults } : {}),
    ...(source.connected ? { connected: source.connected } : {}),
  }
}

function routeProviderListResult(source: RouteProviderList): ProviderListResult {
  const defaultProvider = Object.keys(source.default ?? {})[0]
  return {
    data: source.all
      .map((provider) => routeProviderInfo(provider, source.default?.[provider.id]))
      .sort((a, b) => a.id.localeCompare(b.id)),
    ...(defaultProvider ? { default: defaultProvider } : {}),
  }
}

function routeProviderInfo(provider: RouteProvider, defaultModel: string | undefined): ProviderInfo {
  return {
    id: provider.id,
    value: provider.id,
    name: provider.name,
    label: provider.name,
    displayName: provider.name,
    ...(defaultModel ? { defaultModel } : {}),
    source: provider.source,
    capabilities: {
      source: provider.source,
      modelCount: Object.keys(provider.models ?? {}).length,
      env: provider.env ?? [],
      options: provider.options ?? {},
    },
  }
}

function routeModelListResult(source: RouteProviderList, params: ModelListParams): ModelListResult {
  return {
    data: source.all
      .flatMap((provider) =>
        Object.values(provider.models ?? {})
          .filter((model) => !params.provider || model.providerID === params.provider)
          .map((model) => routeModelInfo(provider, model)),
      )
      .sort((a, b) => a.id.localeCompare(b.id)),
    ...(params.provider && source.default?.[params.provider] ? { default: `${params.provider}/${source.default[params.provider]}` } : {}),
  }
}

function routeModelVariantListResult(source: RouteProviderList, params: ModelVariantListParams): ModelVariantListResult {
  const selected = modelSelection(params.provider, params.model)
  const model = source.all
    .flatMap((provider) => Object.values(provider.models ?? {}))
    .find(
      (item) =>
        (!selected.providerID || item.providerID === selected.providerID) &&
        (!selected.modelID || item.id === selected.modelID) &&
        (selected.providerID !== undefined || selected.modelID !== undefined),
    )
  const variants = model ? routeModelVariants(model) : []
  return {
    data: variants,
    default: variants[0]?.value ?? "",
  }
}

function routeModelInfo(provider: RouteProvider, model: RouteModel): ModelInfo {
  const variants = routeModelVariants(model)
  const input = model.capabilities?.input ?? {}
  const output = model.capabilities?.output ?? {}
  const inputModalities = Object.entries(input)
    .filter((entry) => entry[1])
    .map((entry) => entry[0])
  const outputModalities = Object.entries(output)
    .filter((entry) => entry[1])
    .map((entry) => entry[0])
  const thinking = variants.length > 0 || model.capabilities?.reasoning === true
  return {
    id: `${model.providerID}/${model.id}`,
    value: `${model.providerID}/${model.id}`,
    provider: model.providerID,
    providerID: model.providerID,
    model: model.id,
    modelID: model.id,
    name: model.name,
    label: `${model.name} (${provider.name})`,
    displayName: model.name,
    family: model.family ?? model.providerID,
    supported_reasoning_efforts: variants,
    supportedReasoningEfforts: variants,
    default_reasoning_effort: variants[0]?.value ?? "",
    defaultReasoningEffort: variants[0]?.value ?? "",
    features: {
      thinking,
      multimodalToolUse: inputModalities.some((item) => item !== "text"),
    },
    capabilities: {
      providerID: model.providerID,
      modelID: model.id,
      status: model.status,
      context: model.limit?.context,
      input: model.limit?.input,
      output: model.limit?.output,
      tools: model.capabilities?.toolcall,
      modalities: inputModalities,
      outputModalities,
      reasoning: thinking,
      api: model.api ?? {},
      variants: variants.map((variant) => variant.id),
      cost: model.cost,
    },
  }
}

function routeModelVariants(model: RouteModel): ModelVariantInfo[] {
  return Object.entries(model.variants ?? {}).map((entry) => runtimeVariantInfo(entry[0], entry[1]))
}

function routeModelSelection(params: ModelSelectionParams): RouteModelSelection | undefined {
  if (!params.model) return undefined
  const providerID = params.provider ?? params.model.split("/")[0]
  const modelID =
    params.provider && params.model.startsWith(`${params.provider}/`)
      ? params.model.slice(params.provider.length + 1)
      : params.provider
        ? params.model
        : params.model.slice(providerID.length + 1)
  if (!providerID || !modelID) throw new AppServerError(-32602, "Invalid session model selection.")
  const variant = stringValue(params.variant) ?? stringValue(params.reasoningEffort)
  return {
    providerID,
    modelID,
    ...(variant && variant !== "default" ? { variant } : {}),
  }
}

function routeCreateModel(selected: RouteModelSelection | undefined) {
  if (!selected) return undefined
  return {
    providerID: selected.providerID,
    id: selected.modelID,
    ...(selected.variant ? { variant: selected.variant } : {}),
  }
}

function routeRequireModelSelection(source: RouteProviderList, selected: RouteModelSelection) {
  const model = routeFindModel(source, selected)
  if (!model) throw new AppServerError(-32030, `Model not found: ${selected.providerID}/${selected.modelID}`)
  if (selected.variant && !Object.hasOwn(model.variants ?? {}, selected.variant)) {
    throw new AppServerError(-32031, `Model variant not found: ${selected.providerID}/${selected.modelID}/${selected.variant}`)
  }
}

function routeFindModel(source: RouteProviderList, selected: RouteModelSelection) {
  return source.all
    .flatMap((provider) => Object.values(provider.models ?? {}))
    .find((item) => item.providerID === selected.providerID && item.id === selected.modelID)
}

function routeSessionModelSelection(session: RouteSession): RouteModelSelection | undefined {
  if (!session.model?.providerID) return undefined
  const modelID = session.model.id ?? session.model.modelID
  if (!modelID) return undefined
  return {
    providerID: session.model.providerID,
    modelID,
    ...(session.model.variant ? { variant: session.model.variant } : {}),
  }
}

function routeModelContextWindow(source: RouteProviderList, selected: RouteModelSelection) {
  return positiveNumber(routeFindModel(source, selected)?.limit?.context)
}

function routeSystemPrompt(params: InstructionParams, selected: RouteModelSelection | undefined) {
  const sections = [
    ...(params.builtinInstructions === "none" ? [] : [appServerBuiltinPrompt(selected, params.hostPlatform)]),
    ...params.developerInstructions.map((entry) => entry.text),
    ...params.userDeveloperInstructions.map((entry) => entry.text),
  ].filter((item) => item.trim() !== "")
  return sections.length ? sections.join("\n\n") : undefined
}

async function routeEventLoop(
  client: RouteClient,
  cwd: string,
  signal: AbortSignal,
  activeTurns: Map<string, ActiveTurn>,
  emit: NotificationEmitter,
) {
  const events = await client.event.subscribe(
    { directory: cwd },
    {
      signal,
      sseMaxRetryAttempts: 0,
    },
  )
  for await (const event of events.stream) {
    emit("opencode/event", routeEventEnvelope(cwd, event))
    for (const item of routeTurnNotifications(activeTurns, event)) {
      emit(item.method, item.params)
    }
  }
}

function routeEventEnvelope(cwd: string, event: unknown) {
  const item = record(event)
  const properties = record(item.properties)
  return {
    id: stringValue(item.id),
    type: stringValue(item.type),
    sessionID: routeEventSessionID(stringValue(item.type), properties),
    directory: cwd,
    properties,
  }
}

export function turnNotifications(activeTurns: Map<string, ActiveTurn>, event: unknown): JsonRpcNotification[] {
  return routeTurnNotifications(activeTurns, event)
}

function routeTurnNotifications(activeTurns: Map<string, ActiveTurn>, event: unknown): JsonRpcNotification[] {
  const item = record(event)
  const type = stringValue(item.type)
  const properties = record(item.properties)
  const sessionId = routeEventSessionID(type, properties)
  if (!type || !sessionId) return []
  const turn = activeTurns.get(sessionId)
  if (!turn) return []

  if (type === "message.updated") return routeMessageUpdatedNotifications(turn, properties)
  if (type === "message.part.delta") return routePartDeltaNotifications(turn, properties)
  if (type === "message.part.updated") return routePartUpdatedNotifications(turn, properties)
  if (type === "session.error") {
    return turnFailureNotifications(activeTurns, sessionId, properties.error ?? { type: "unknown", message: "Session failed." })
  }
  if (type === "session.status") return routeSessionStatusNotifications(activeTurns, sessionId, properties)
  if (type === "permission.asked") return routePermissionAskedNotifications(turn, properties)
  if (type === "permission.replied") return routePermissionRepliedNotifications(turn, properties)
  if (type === "question.asked") return routeQuestionAskedNotifications(turn, properties)
  if (type === "question.replied") return routeQuestionResolvedNotifications(turn, properties, "answered")
  if (type === "question.rejected") return routeQuestionResolvedNotifications(turn, properties, "rejected")
  return []
}

function routeEventSessionID(type: string | undefined, properties: Record<string, unknown>) {
  if (type === "message.part.delta") {
    return stringValue(properties.sessionID)
  }
  if (type === "message.part.updated" || type === "message.part.removed") {
    return stringValue(record(properties.part).sessionID)
  }
  if (type === "message.updated" || type === "message.removed") {
    return stringValue(record(properties.info).sessionID)
  }
  if (type === "permission.asked" || type === "question.asked") {
    return stringValue(properties.sessionID)
  }
  if (type === "permission.replied" || type === "question.replied" || type === "question.rejected") {
    return stringValue(properties.sessionID)
  }
  return stringValue(properties.sessionID)
}

function routeMessageUpdatedNotifications(turn: ActiveTurn, properties: Record<string, unknown>): JsonRpcNotification[] {
  const info = record(properties.info)
  if (stringValue(info.role) !== "assistant") return []
  const messageId = stringValue(info.id)
  if (messageId) {
    const assistantMessageIds = turn.assistantMessageIds ?? new Set<string>()
    assistantMessageIds.add(messageId)
    turn.assistantMessageIds = assistantMessageIds
  }
  if (turn.started) return []
  turn.started = true
  return [
    notification("turn/started", {
      ...turnBase(turn),
      messageId,
    }),
    notification("turn/modelInfo", {
      ...turnBase(turn),
      model: modelPayload(
        {
          providerID: stringValue(info.providerID),
          id: stringValue(info.modelID),
          variant: stringValue(info.variant),
        },
        turn.contextWindow,
      ),
    }),
  ]
}

function routePartUpdatedNotifications(turn: ActiveTurn, properties: Record<string, unknown>): JsonRpcNotification[] {
  const part = record(properties.part)
  const messageId = stringValue(part.messageID)
  if (!messageId || !turn.assistantMessageIds?.has(messageId)) return []
  const type = stringValue(part.type)
  const partId = stringValue(part.id)
  if (partId && type) {
    const partTypes = turn.partTypes ?? new Map<string, string>()
    partTypes.set(partId, type)
    turn.partTypes = partTypes
  }
  if (type === "text") return routeTextPartNotifications(turn, part)
  if (type === "reasoning") return routeReasoningPartNotifications(turn, part)
  if (type === "tool") return routeToolPartNotifications(turn, part)
  if (type === "step-finish") return routeStepFinishNotifications(turn, part)
  return []
}

function routePartDeltaNotifications(turn: ActiveTurn, properties: Record<string, unknown>): JsonRpcNotification[] {
  const messageId = stringValue(properties.messageID)
  if (!messageId || !turn.assistantMessageIds?.has(messageId)) return []
  if (stringValue(properties.field) !== "text") return []
  const partId = stringValue(properties.partID)
  const delta = stringValue(properties.delta)
  if (!partId || !delta) return []
  const type = turn.partTypes?.get(partId)
  if (type !== "text" && type !== "reasoning") return []
  const lengths = turn.partLengths ?? new Map<string, number>()
  turn.partLengths = lengths
  lengths.set(partId, (lengths.get(partId) ?? 0) + delta.length)
  if (type === "text") {
    turn.content.push(delta)
    return [notification("turn/contentDelta", { ...turnBase(turn), delta, textId: partId })]
  }
  turn.reasoning.push(delta)
  return [notification("turn/thoughtDelta", { ...turnBase(turn), delta, reasoningId: partId })]
}

function routeTextPartNotifications(turn: ActiveTurn, part: Record<string, unknown>): JsonRpcNotification[] {
  const text = stringValue(part.text) ?? ""
  const lengths = turn.partLengths ?? new Map<string, number>()
  turn.partLengths = lengths
  const previous = lengths.get(String(part.id)) ?? 0
  if (text.length <= previous) return []
  lengths.set(String(part.id), text.length)
  const delta = text.slice(previous)
  turn.content.push(delta)
  return [notification("turn/contentDelta", { ...turnBase(turn), delta, textId: stringValue(part.id) })]
}

function routeReasoningPartNotifications(turn: ActiveTurn, part: Record<string, unknown>): JsonRpcNotification[] {
  const text = stringValue(part.text) ?? ""
  const lengths = turn.partLengths ?? new Map<string, number>()
  turn.partLengths = lengths
  const previous = lengths.get(String(part.id)) ?? 0
  if (text.length <= previous) return []
  lengths.set(String(part.id), text.length)
  const delta = text.slice(previous)
  turn.reasoning.push(delta)
  return [notification("turn/thoughtDelta", { ...turnBase(turn), delta, reasoningId: stringValue(part.id) })]
}

function routeToolPartNotifications(turn: ActiveTurn, part: Record<string, unknown>): JsonRpcNotification[] {
  const state = record(part.state)
  const status = stringValue(state.status)
  const toolCallId = stringValue(part.callID) ?? stringValue(part.id)
  const toolStates = turn.toolStates ?? new Map<string, string>()
  turn.toolStates = toolStates
  if (!status) return []
  const statusKey = status === "running" ? `${status}:${JSON.stringify(state.input ?? {})}` : status
  const previous = toolStates.get(String(toolCallId))
  if (previous === statusKey) return []
  toolStates.set(String(toolCallId), statusKey)
  if (status === "pending") return []
  if (status === "running") {
    return [
      notification("turn/toolCallRequested", {
        ...turnBase(turn),
        toolCallId,
        messageId: stringValue(part.messageID),
        tool: stringValue(part.tool),
        input: state.input,
        raw: stringValue(state.raw),
      }),
    ]
  }
  if (status === "completed") {
    return [
      notification("turn/toolCallCompleted", {
        ...turnBase(turn),
        status: "completed",
        toolCallId,
        messageId: stringValue(part.messageID),
        structured: state.metadata,
        content: stringValue(state.output),
        result: state.output,
        title: stringValue(state.title),
      }),
    ]
  }
  if (status === "error") {
    return [
      notification("turn/toolCallCompleted", {
        ...turnBase(turn),
        status: "failed",
        toolCallId,
        messageId: stringValue(part.messageID),
        error: stringValue(state.error),
        result: stringValue(state.error),
      }),
    ]
  }
  return []
}

function routeStepFinishNotifications(turn: ActiveTurn, part: Record<string, unknown>): JsonRpcNotification[] {
  const usage = tokenUsage(part.tokens, turn.contextWindow)
  return [
    notification("turn/usage", {
      ...turnBase(turn),
      tokens: part.tokens,
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

function routeSessionStatusNotifications(
  activeTurns: Map<string, ActiveTurn>,
  sessionId: string,
  properties: Record<string, unknown>,
): JsonRpcNotification[] {
  const status = record(properties.status)
  if (stringValue(status.type) !== "idle") return []
  const turn = activeTurns.get(sessionId)
  if (!turn) return []
  void cleanupActiveTurn(activeTurns, sessionId)
  return [
    notification("turn/completed", {
      ...turnBase(turn),
      status: turn.cancelRequested ? "cancelled" : "completed",
      content: turn.content.join(""),
      reasoning: turn.reasoning.join(""),
    }),
  ]
}

function routePermissionAskedNotifications(turn: ActiveTurn, properties: Record<string, unknown>): JsonRpcNotification[] {
  const tool = record(properties.tool)
  return [
    notification("turn/toolApprovalRequested", {
      ...turnBase(turn),
      approvalId: stringValue(properties.id),
      requestId: stringValue(properties.id),
      permission: stringValue(properties.permission),
      action: stringValue(properties.permission),
      resources: stringArrayValue(properties.patterns),
      save: stringArrayValue(properties.always),
      metadata: record(properties.metadata),
      source: properties.tool,
      toolCallId: stringValue(tool.callID),
      messageId: stringValue(tool.messageID),
      options: ["once", "always", "reject"],
    }),
  ]
}

function routePermissionRepliedNotifications(turn: ActiveTurn, properties: Record<string, unknown>): JsonRpcNotification[] {
  return [
    notification("turn/toolApprovalResolved", {
      ...turnBase(turn),
      approvalId: stringValue(properties.requestID),
      requestId: stringValue(properties.requestID),
      reply: stringValue(properties.reply),
    }),
  ]
}

function routeQuestionAskedNotifications(turn: ActiveTurn, properties: Record<string, unknown>): JsonRpcNotification[] {
  const tool = record(properties.tool)
  return [
    notification("turn/userInputRequested", {
      ...turnBase(turn),
      requestId: stringValue(properties.id),
      questionId: stringValue(properties.id),
      questions: properties.questions,
      tool: properties.tool,
      toolCallId: stringValue(tool.callID),
      messageId: stringValue(tool.messageID),
    }),
  ]
}

function routeQuestionResolvedNotifications(
  turn: ActiveTurn,
  properties: Record<string, unknown>,
  status: "answered" | "rejected",
): JsonRpcNotification[] {
  return [
    notification("turn/userInputResolved", {
      ...turnBase(turn),
      requestId: stringValue(properties.requestID),
      questionId: stringValue(properties.requestID),
      status,
      answers: properties.answers,
    }),
  ]
}

async function routeSessionMessages(client: RouteClient, params: SessionMessagesParams): Promise<SessionMessagesResult> {
  if (params.order !== undefined && params.order !== "desc") {
    throw new AppServerError(-32602, "session/messages only supports desc order through the HTTP route.")
  }
  if (params.cursor?.direction === "next") {
    throw new AppServerError(-32602, "session/messages cursor direction next is not supported by the HTTP route.")
  }
  const session = await routeData<RouteSession>("session.get", client.session.get({ sessionID: params.sessionId }), {
    notFound: new AppServerError(-32010, `Session not found: ${params.sessionId}`),
  })
  const response = record(
    await client.session.messages({
      sessionID: session.id,
      directory: session.directory,
      ...(params.limit ? { limit: params.limit } : {}),
      ...(params.cursor ? { before: params.cursor.id } : {}),
    }),
  )
  if (response.error !== undefined) {
    throw routeError("session.messages", response.error, {
      notFound: new AppServerError(-32010, `Session not found: ${params.sessionId}`),
    })
  }
  if (!("data" in response)) throw new AppServerError(-32603, "session.messages returned no data.")
  const messages = Array.isArray(response.data) ? response.data : []
  const httpResponse = response.response instanceof Response ? response.response : undefined
  const nextCursor = httpResponse?.headers.get("x-next-cursor") ?? undefined
  return {
    sessionId: session.id,
    providerSessionId: session.id,
    threadId: session.id,
    data: messages,
    messages,
    ...(nextCursor ? { cursor: { id: nextCursor, direction: "previous" }, nextCursor } : {}),
  }
}

function routeSessionCreateResult(session: RouteSession): SessionCreateResult {
  return routeSessionInfo(session)
}

function routeSessionStatusResult(session: RouteSession): SessionStatusResult {
  return {
    ...routeSessionInfo(session),
    exists: true,
    active: false,
    busy: false,
    pending: false,
    status: "idle",
  }
}

function routeSessionResumeResult(session: RouteSession): SessionResumeResult {
  return {
    resumed: true,
    sessionId: session.id,
    providerSessionId: session.id,
    threadId: session.id,
  }
}

function routeSessionInfo(session: RouteSession): SessionInfo {
  return {
    sessionId: session.id,
    providerSessionId: session.id,
    threadId: session.id,
    cwd: session.directory,
    ...routeSessionModelFields(session),
    title: session.title,
    createdAt: new Date(session.time.created).toISOString(),
    updatedAt: new Date(session.time.updated).toISOString(),
  }
}

function routeSessionModelFields(session: RouteSession) {
  const selected = routeSessionModelSelection(session)
  if (!selected) return {}
  return {
    provider: selected.providerID,
    model: selected.modelID,
    ...(selected.variant ? { variant: selected.variant } : {}),
  }
}

function routeTurnCancelResult(session: RouteSession, active: ActiveTurn | undefined): TurnCancelResult {
  return {
    cancelled: true,
    active: active !== undefined,
    sessionId: session.id,
    providerSessionId: session.id,
    threadId: session.id,
    ...(active ? { turnId: active.turnId } : {}),
  }
}

function routeToolApprovalRespondResult(
  session: RouteSession,
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

function routeUserInputRespondResult(session: RouteSession, params: UserInputRespondParams): UserInputRespondResult {
  return {
    ok: true,
    sessionId: session.id,
    providerSessionId: session.id,
    threadId: session.id,
    requestId: params.requestId,
    answers: params.answers,
  }
}

function routeUserInputRejectResult(session: RouteSession, params: UserInputRejectParams): UserInputRejectResult {
  return {
    ok: true,
    rejected: true,
    sessionId: session.id,
    providerSessionId: session.id,
    threadId: session.id,
    requestId: params.requestId,
  }
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
    await services.dispose?.()
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

  if (request.method === "session/messages") {
    const params = sessionMessagesParams(request.params)
    if (!params) return { response: error(id.value, -32602, "Invalid params") }
    const sessionMessages = services.sessionMessages
    if (!sessionMessages) return { response: error(id.value, -32601, "Method not found: session/messages") }
    return handleAsync(id.value, request.method, () => sessionMessages(params))
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

function sessionMessagesParams(value: unknown): SessionMessagesParams | undefined {
  const params = paramsObject(value)
  if (!params) return undefined
  const sessionId = firstString(params.sessionId, params.providerSessionId, params.threadId)
  if (!sessionId) return undefined
  const limit = optionalPositiveInteger(params.limit)
  if (params.limit !== undefined && limit === undefined) return undefined
  if (params.order !== undefined && params.order !== "asc" && params.order !== "desc") return undefined
  const cursor = sessionMessagesCursor(params.cursor)
  if (params.cursor !== undefined && !cursor) return undefined
  return {
    sessionId,
    ...(limit ? { limit } : {}),
    ...(params.order ? { order: params.order } : {}),
    ...(cursor ? { cursor } : {}),
  }
}

function sessionMessagesCursor(value: unknown): SessionMessagesParams["cursor"] | undefined {
  if (value === undefined) return undefined
  const params = paramsObject(value)
  if (!params) return undefined
  const id = firstString(params.id, params.messageId, params.messageID)
  if (!id) return undefined
  if (params.direction !== "previous" && params.direction !== "next") return undefined
  return { id, direction: params.direction }
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

function permissionReplyValue(...values: unknown[]): PermissionReply | undefined {
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
      mcp: false,
    },
  }
}

function turnFailureNotifications(
  activeTurns: Map<string, ActiveTurn>,
  sessionId: string,
  eventError: unknown,
): JsonRpcNotification[] {
  const turn = activeTurns.get(sessionId)
  if (!turn) return []
  void cleanupActiveTurn(activeTurns, sessionId)
  if (routeAbortError(eventError)) {
    return [
      notification("turn/completed", {
        ...turnBase(turn),
        status: "cancelled",
        content: turn.content.join(""),
        reasoning: turn.reasoning.join(""),
      }),
    ]
  }
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

function routeAbortError(value: unknown) {
  const error = record(value)
  const data = record(error.data)
  return (
    stringValue(error.name) === "MessageAbortedError" ||
    stringValue(error.message) === "Aborted" ||
    stringValue(data.message) === "Aborted"
  )
}

async function cleanupActiveTurn(activeTurns: Map<string, ActiveTurn>, sessionId: string) {
  const turn = activeTurns.get(sessionId)
  activeTurns.delete(sessionId)
  await turn?.cleanup?.()
}

async function cleanupAllActiveTurns(activeTurns: Map<string, ActiveTurn>) {
  await Promise.all([...activeTurns.keys()].map((sessionId) => cleanupActiveTurn(activeTurns, sessionId)))
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

function appServerBuiltinPrompt(model: RouteModelSelection | undefined, hostPlatform: string | undefined) {
  const modelID = model ? `${model.providerID}/${model.modelID}${model.variant ? `/${model.variant}` : ""}` : undefined
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
