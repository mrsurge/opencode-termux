import { describe, expect, test } from "bun:test"
import { Duration, Effect } from "effect"
import { type AppServerHandle, cliIt } from "../../lib/cli-process"
import { handleLine, turnNotifications, type ActiveTurn } from "../../../src/cli/cmd/app-server"

describe("opencode app-server subprocess", () => {
  cliIt.live(
    "initializes and shuts down over stdio JSON-RPC",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const config = JSON.stringify({
          provider: {
            test: {
              name: "Test",
              id: "test",
              env: ["TEST_API_KEY"],
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: llm.url },
              models: {
                "test-model": {
                  id: "test-model",
                  name: "Test Model",
                  attachment: false,
                  reasoning: false,
                  temperature: false,
                  tool_call: true,
                  release_date: "2025-01-01",
                  limit: { context: 100_000, output: 10_000 },
                  cost: { input: 0, output: 0 },
                  variants: {
                    low: { body: { reasoningEffort: "low" } },
                    high: { body: { reasoningEffort: "high" } },
                  },
                },
              },
            },
          },
          permission: { edit: "ask" },
        })
        yield* Effect.promise(() =>
          Bun.write(
            `${home}/opencode.json`,
            config,
          ),
        )
        const appServer = yield* opencode.appServer({
          env: { OPENCODE_DISABLE_PROJECT_CONFIG: "0", OPENCODE_CONFIG_CONTENT: config, TEST_API_KEY: "test-key" },
        })

        yield* appServer.send({ jsonrpc: "2.0", id: 1, method: "server/initialize", params: {} })
        const initialized = yield* appServer.receive.pipe(Effect.timeout(Duration.seconds(20)))
        expect(initialized).toEqual({
          jsonrpc: "2.0",
          id: 1,
          result: {
            serverName: "opencode-app-server",
            protocolVersion: "0.1.0",
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
          },
        })

        yield* appServer.send({ jsonrpc: "2.0", id: 2, method: "provider/list", params: {} })
        const providers = yield* appServer.receive.pipe(Effect.timeout(Duration.seconds(10)))
        expect(providers).toMatchObject({
          jsonrpc: "2.0",
          id: 2,
        })
        const providerData = (providers as { result: { data: unknown[] } }).result.data
        expect(providerData.length).toBeGreaterThan(0)
        const catalogProvider = objectRecord(providerData.find((item) => stringField(objectRecord(item) ?? {}, "id") === "openrouter")) ?? objectRecord(providerData[0])
        if (!catalogProvider) throw new Error("provider/list returned no provider records")
        const catalogProviderId = stringField(catalogProvider, "id")

        yield* appServer.send({ jsonrpc: "2.0", id: 3, method: "model/list", params: { provider: catalogProviderId } })
        const models = yield* appServer.receive.pipe(Effect.timeout(Duration.seconds(10)))
        expect(models).toMatchObject({
          jsonrpc: "2.0",
          id: 3,
        })
        const modelData = (models as { result: { data: unknown[] } }).result.data
        expect(modelData.length).toBeGreaterThan(0)
        expect(modelData[0]).toMatchObject({ provider: catalogProviderId, providerID: catalogProviderId })
        const variantModel = objectRecord(
          modelData.find((item) => {
            const efforts = objectRecord(item)?.supportedReasoningEfforts
            return Array.isArray(efforts) && efforts.length > 0
          }),
        )
        if (variantModel) {
          yield* appServer.send({
            jsonrpc: "2.0",
            id: 40,
            method: "model/variant/list",
            params: { provider: catalogProviderId, model: stringField(variantModel, "modelID") },
          })
          const variants = yield* appServer.receive.pipe(Effect.timeout(Duration.seconds(10)))
          expect(variants).toMatchObject({
            jsonrpc: "2.0",
            id: 40,
            result: {
              data: variantModel.supportedReasoningEfforts,
              default: stringField(variantModel, "defaultReasoningEffort"),
            },
          })
        }

        yield* appServer.send({
          jsonrpc: "2.0",
          id: 4,
          method: "session/create",
          params: {
            cwd: home,
            provider: "test",
            model: "test-model",
            reasoningEffort: "high",
            mcpServers: {
              "app-server-disabled": {
                type: "local",
                command: ["echo", "disabled"],
                disabled: true,
              },
            },
          },
        })
        const created = yield* appServer.receive.pipe(Effect.timeout(Duration.seconds(30)))
        expect(created).toMatchObject({
          jsonrpc: "2.0",
          id: 4,
          result: {
            cwd: home,
            provider: "test",
            model: "test-model",
            variant: "high",
          },
        })
        const sessionResult = (created as { result: { sessionId: string; providerSessionId: string; threadId: string } })
          .result
        expect(sessionResult.sessionId).toStartWith("ses_")
        expect(sessionResult.providerSessionId).toBe(sessionResult.sessionId)
        expect(sessionResult.threadId).toBe(sessionResult.sessionId)

        yield* appServer.send({
          jsonrpc: "2.0",
          id: 5,
          method: "session/status",
          params: { sessionId: sessionResult.sessionId },
        })
        const status = yield* appServer.receive.pipe(Effect.timeout(Duration.seconds(10)))
        expect(status).toMatchObject({
          jsonrpc: "2.0",
          id: 5,
          result: {
            sessionId: sessionResult.sessionId,
            providerSessionId: sessionResult.sessionId,
            threadId: sessionResult.sessionId,
            cwd: home,
            provider: "test",
            model: "test-model",
            variant: "high",
            exists: true,
            active: false,
            busy: false,
            pending: false,
            status: "idle",
          },
        })

        yield* appServer.send({ jsonrpc: "2.0", id: 6, method: "session/list", params: {} })
        const sessions = yield* appServer.receive.pipe(Effect.timeout(Duration.seconds(10)))
        expect(sessions).toMatchObject({
          jsonrpc: "2.0",
          id: 6,
        })
        expect((sessions as { result: { data: unknown[] } }).result.data).toContainEqual(
          expect.objectContaining({
            sessionId: sessionResult.sessionId,
            providerSessionId: sessionResult.sessionId,
            threadId: sessionResult.sessionId,
            cwd: home,
            provider: "test",
            model: "test-model",
            variant: "high",
          }),
        )

        yield* appServer.send({
          jsonrpc: "2.0",
          id: 7,
          method: "session/resume",
          params: { providerSessionId: sessionResult.sessionId },
        })
        const resumed = yield* appServer.receive.pipe(Effect.timeout(Duration.seconds(10)))
        expect(resumed).toMatchObject({
          jsonrpc: "2.0",
          id: 7,
          result: {
            resumed: true,
            sessionId: sessionResult.sessionId,
            providerSessionId: sessionResult.sessionId,
            threadId: sessionResult.sessionId,
          },
        })

        yield* appServer.send({
          jsonrpc: "2.0",
          id: 41,
          method: "turn/start",
          params: {
            sessionId: sessionResult.sessionId,
            prompt: "invalid variant should not admit a turn",
            provider: "test",
            model: "test-model",
            reasoningEffort: "missing",
          },
        })
        const invalidVariantMessages = yield* receiveUntil(appServer, (messages) =>
          messages.some((message) => isResponse(message, 41)),
        )
        const invalidVariant = objectRecord(invalidVariantMessages.find((message) => isResponse(message, 41)))
        expect(invalidVariant).toEqual({
          jsonrpc: "2.0",
          id: 41,
          error: {
            code: -32031,
            message: "Model variant not found: test/test-model/missing",
          },
        })

        yield* llm.text("app-server turn ok")
        yield* appServer.send({
          jsonrpc: "2.0",
          id: 8,
          method: "turn/start",
          params: {
            sessionId: sessionResult.sessionId,
            prompt: "say ok",
            provider: "test",
            model: "test-model",
            reasoningEffort: "low",
          },
        })
        const turnMessages = yield* receiveUntil(
          appServer,
          (messages) =>
            messages.some((message) => isResponse(message, 8)) &&
            messages.some((message) => isNotification(message, "turn/completed")),
        )
        expect(notificationParamList(turnMessages, "turn/modelInfo")).toContainEqual(
          expect.objectContaining({
            sessionId: sessionResult.sessionId,
            model: expect.objectContaining({
              providerID: "test",
              modelID: "test-model",
              variant: "low",
            }),
          }),
        )
        expect(turnMessages).toContainEqual(
          expect.objectContaining({
            jsonrpc: "2.0",
            id: 8,
            result: expect.objectContaining({
              accepted: true,
              sessionId: sessionResult.sessionId,
              providerSessionId: sessionResult.sessionId,
              threadId: sessionResult.sessionId,
            }),
          }),
        )
        expect(turnMessages).toContainEqual(
          expect.objectContaining({
            jsonrpc: "2.0",
            method: "turn/contentDelta",
            params: expect.objectContaining({
              sessionId: sessionResult.sessionId,
              providerSessionId: sessionResult.sessionId,
              threadId: sessionResult.sessionId,
              delta: "app-server turn ok",
            }),
          }),
        )
        expect(turnMessages).toContainEqual(
          expect.objectContaining({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: expect.objectContaining({
              sessionId: sessionResult.sessionId,
              providerSessionId: sessionResult.sessionId,
              threadId: sessionResult.sessionId,
              status: "completed",
              content: "app-server turn ok",
            }),
          }),
        )

        yield* appServer.send({
          jsonrpc: "2.0",
          id: 9,
          method: "turn/cancel",
          params: { threadId: sessionResult.sessionId },
        })
        const cancelledMessages = yield* receiveUntil(appServer, (messages) =>
          messages.some((message) => isResponse(message, 9)),
        )
        const cancelled = responseWithId(cancelledMessages, 9)
        expect(cancelled).toMatchObject({
          jsonrpc: "2.0",
          id: 9,
          result: {
            cancelled: true,
            active: false,
            sessionId: sessionResult.sessionId,
            providerSessionId: sessionResult.sessionId,
            threadId: sessionResult.sessionId,
          },
        })

        yield* llm.tool("write", { filePath: "approval.txt", content: "approved\n" })
        yield* appServer.send({
          jsonrpc: "2.0",
          id: 10,
          method: "turn/start",
          params: { sessionId: sessionResult.sessionId, prompt: "write approval file" },
        })
        const approvalMessages = yield* receiveUntil(
          appServer,
          (messages) =>
            messages.some((message) => isResponse(message, 10)) &&
            messages.some((message) => isNotification(message, "turn/toolApprovalRequested")),
        )
        const approval = notificationParams(approvalMessages, "turn/toolApprovalRequested")
        expect(approval).toMatchObject({
          sessionId: sessionResult.sessionId,
          providerSessionId: sessionResult.sessionId,
          threadId: sessionResult.sessionId,
          permission: "edit",
          action: "edit",
          resources: [expect.stringContaining("approval.txt")],
        })

        yield* appServer.send({
          jsonrpc: "2.0",
          id: 11,
          method: "turn/toolApproval/respond",
          params: {
            providerSessionId: sessionResult.sessionId,
            approvalId: stringField(approval, "approvalId"),
            decision: "accept",
          },
        })
        const approvalCompletionMessages = yield* receiveUntil(
          appServer,
          (messages) =>
            messages.some((message) => isResponse(message, 11)) &&
            messages.some((message) => isNotification(message, "turn/toolApprovalResolved")) &&
            messages.some((message) => isNotification(message, "turn/toolCallCompleted")) &&
            messages.some((message) => isNotification(message, "turn/completed")),
        )
        expect(approvalCompletionMessages).toContainEqual(
          expect.objectContaining({
            jsonrpc: "2.0",
            id: 11,
            result: expect.objectContaining({
              ok: true,
              reply: "once",
            }),
          }),
        )
        expect(approvalCompletionMessages).toContainEqual(
          expect.objectContaining({
            jsonrpc: "2.0",
            method: "turn/toolCallCompleted",
            params: expect.objectContaining({
              sessionId: sessionResult.sessionId,
              status: "completed",
              structured: expect.objectContaining({
                filepath: expect.stringContaining("approval.txt"),
              }),
            }),
          }),
        )

        yield* appServer.send({
          jsonrpc: "2.0",
          id: 12,
          method: "turn/toolApproval/respond",
          params: {
            sessionId: sessionResult.sessionId,
            approvalId: "per_missing",
            decision: "reject",
          },
        })
        const staleApprovalMessages = yield* receiveUntil(appServer, (messages) =>
          messages.some((message) => isResponse(message, 12)),
        )
        const staleApproval = responseWithId(staleApprovalMessages, 12)
        expect(staleApproval).toEqual({
          jsonrpc: "2.0",
          id: 12,
          error: {
            code: -32040,
            message: "Permission request not found: per_missing",
          },
        })

        yield* llm.tool("write", { filePath: "reject.txt", content: "rejected\n" })
        yield* appServer.send({
          jsonrpc: "2.0",
          id: 13,
          method: "turn/start",
          params: { sessionId: sessionResult.sessionId, prompt: "write rejected file" },
        })
        const rejectApprovalMessages = yield* receiveUntil(
          appServer,
          (messages) =>
            messages.some((message) => isResponse(message, 13)) &&
            messages.some((message) => isNotification(message, "turn/toolApprovalRequested")),
        )
        const rejectApproval = notificationParams(rejectApprovalMessages, "turn/toolApprovalRequested")

        yield* appServer.send({
          jsonrpc: "2.0",
          id: 14,
          method: "turn/toolApproval/respond",
          params: {
            sessionId: sessionResult.sessionId,
            approvalId: stringField(rejectApproval, "approvalId"),
            decision: "reject",
          },
        })
        const rejectCompletionMessages = yield* receiveUntil(
          appServer,
          (messages) =>
            messages.some((message) => isResponse(message, 14)) &&
            messages.some((message) => isNotification(message, "turn/toolApprovalResolved")) &&
            messages.some((message) => isNotification(message, "turn/toolCallCompleted")) &&
            messages.some((message) => isNotification(message, "turn/completed")),
        )
        expect(rejectCompletionMessages).toContainEqual(
          expect.objectContaining({
            jsonrpc: "2.0",
            id: 14,
            result: expect.objectContaining({
              ok: true,
              reply: "reject",
            }),
          }),
        )
        expect(rejectCompletionMessages).toContainEqual(
          expect.objectContaining({
            jsonrpc: "2.0",
            method: "turn/toolApprovalResolved",
            params: expect.objectContaining({
              requestId: stringField(rejectApproval, "approvalId"),
              reply: "reject",
            }),
          }),
        )
        expect(rejectCompletionMessages).toContainEqual(
          expect.objectContaining({
            jsonrpc: "2.0",
            method: "turn/toolCallCompleted",
            params: expect.objectContaining({
              status: "failed",
            }),
          }),
        )
        expect(rejectCompletionMessages).toContainEqual(
          expect.objectContaining({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: expect.objectContaining({
              status: "completed",
            }),
          }),
        )

        yield* llm.tool("write", { filePath: "always-first.txt", content: "always first\n" })
        yield* appServer.send({
          jsonrpc: "2.0",
          id: 15,
          method: "turn/start",
          params: { sessionId: sessionResult.sessionId, prompt: "write first always file" },
        })
        const alwaysApprovalMessages = yield* receiveUntil(
          appServer,
          (messages) =>
            messages.some((message) => isResponse(message, 15)) &&
            messages.some((message) => isNotification(message, "turn/toolApprovalRequested")),
        )
        const alwaysApproval = notificationParams(alwaysApprovalMessages, "turn/toolApprovalRequested")

        yield* appServer.send({
          jsonrpc: "2.0",
          id: 16,
          method: "turn/toolApproval/respond",
          params: {
            sessionId: sessionResult.sessionId,
            requestId: stringField(alwaysApproval, "requestId"),
            reply: "always",
          },
        })
        const alwaysCompletionMessages = yield* receiveUntil(
          appServer,
          (messages) =>
            messages.some((message) => isResponse(message, 16)) &&
            messages.some((message) => isNotification(message, "turn/toolApprovalResolved")) &&
            messages.some((message) => isNotification(message, "turn/toolCallCompleted")) &&
            messages.some((message) => isNotification(message, "turn/completed")),
        )
        expect(alwaysCompletionMessages).toContainEqual(
          expect.objectContaining({
            jsonrpc: "2.0",
            id: 16,
            result: expect.objectContaining({
              ok: true,
              reply: "always",
            }),
          }),
        )
        expect(alwaysCompletionMessages).toContainEqual(
          expect.objectContaining({
            jsonrpc: "2.0",
            method: "turn/toolApprovalResolved",
            params: expect.objectContaining({
              requestId: stringField(alwaysApproval, "requestId"),
              reply: "always",
            }),
          }),
        )

        yield* llm.tool("write", { filePath: "always-second.txt", content: "always second\n" })
        yield* appServer.send({
          jsonrpc: "2.0",
          id: 17,
          method: "turn/start",
          params: { sessionId: sessionResult.sessionId, prompt: "write second always file" },
        })
        const savedPermissionMessages = yield* receiveUntil(
          appServer,
          (messages) =>
            messages.some((message) => isResponse(message, 17)) &&
            messages.some((message) => isNotification(message, "turn/toolCallCompleted")) &&
            messages.some((message) => isNotification(message, "turn/completed")),
        )
        expect(savedPermissionMessages.some((message) => isNotification(message, "turn/toolApprovalRequested"))).toBe(
          false,
        )
        expect(savedPermissionMessages).toContainEqual(
          expect.objectContaining({
            jsonrpc: "2.0",
            method: "turn/toolCallCompleted",
            params: expect.objectContaining({
              status: "completed",
              structured: expect.objectContaining({
                filepath: expect.stringContaining("always-second.txt"),
              }),
            }),
          }),
        )

        yield* appServer.send({ jsonrpc: "2.0", id: 18, method: "server/shutdown" })
        const shutdownMessages = yield* receiveUntil(appServer, (messages) =>
          messages.some((message) => isResponse(message, 18)),
        )
        const shutdown = responseWithId(shutdownMessages, 18)
        expect(shutdown).toEqual({
          jsonrpc: "2.0",
          id: 18,
          result: { ok: true },
        })

        const code = yield* Effect.promise(() => appServer.exited).pipe(Effect.timeout(Duration.seconds(30)))
        expect(code).toBe(0)
      }),
    90_000,
  )
})

describe("opencode app-server cancellation", () => {
  cliIt.live(
    "settles active turns when cancellation interrupts approval or continuation",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const config = JSON.stringify({
          provider: {
            test: {
              name: "Test",
              id: "test",
              env: ["TEST_API_KEY"],
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: llm.url },
              models: {
                "test-model": {
                  id: "test-model",
                  name: "Test Model",
                  attachment: false,
                  reasoning: false,
                  temperature: false,
                  tool_call: true,
                  release_date: "2025-01-01",
                  limit: { context: 100_000, output: 10_000 },
                  cost: { input: 0, output: 0 },
                },
              },
            },
          },
          permission: { edit: "ask" },
        })
        yield* Effect.promise(() =>
          Bun.write(
            `${home}/opencode.json`,
            config,
          ),
        )
        const appServer = yield* opencode.appServer({
          env: { OPENCODE_DISABLE_PROJECT_CONFIG: "0", OPENCODE_CONFIG_CONTENT: config, TEST_API_KEY: "test-key" },
        })

        yield* appServer.send({
          jsonrpc: "2.0",
          id: 1,
          method: "session/create",
          params: { cwd: home, provider: "test", model: "test-model" },
        })
        const created = yield* appServer.receive.pipe(Effect.timeout(Duration.seconds(30)))
        const sessionResult = (created as { result: { sessionId: string } }).result

        yield* llm.tool("write", { filePath: "cancel-approval.txt", content: "cancelled\n" })
        yield* appServer.send({
          jsonrpc: "2.0",
          id: 2,
          method: "turn/start",
          params: { sessionId: sessionResult.sessionId, prompt: "write then wait for cancellation" },
        })
        yield* receiveUntil(
          appServer,
          (messages) =>
            messages.some((message) => isResponse(message, 2)) &&
            messages.some((message) => isNotification(message, "turn/toolApprovalRequested")),
        )

        yield* appServer.send({
          jsonrpc: "2.0",
          id: 3,
          method: "turn/cancel",
          params: { sessionId: sessionResult.sessionId },
        })
        const cancelledApprovalMessages = yield* receiveUntil(
          appServer,
          (messages) =>
            messages.some((message) => isResponse(message, 3)) &&
            messages.some((message) => isNotification(message, "turn/completed")),
        )
        expect(cancelledApprovalMessages).toContainEqual(
          expect.objectContaining({
            jsonrpc: "2.0",
            id: 3,
            result: expect.objectContaining({
              cancelled: true,
              active: true,
            }),
          }),
        )
        expect(notificationParamList(cancelledApprovalMessages, "turn/completed")).toEqual([
          expect.objectContaining({
            sessionId: sessionResult.sessionId,
            status: "cancelled",
          }),
        ])

        yield* llm.tool("write", { filePath: "cancel-continuation.txt", content: "before continuation\n" })
        let releaseContinuation!: () => void
        const heldContinuation = new Promise<void>((resolve) => {
          releaseContinuation = resolve
        })
        yield* llm.hold("released after cancellation", heldContinuation)
        yield* appServer.send({
          jsonrpc: "2.0",
          id: 4,
          method: "turn/start",
          params: { sessionId: sessionResult.sessionId, prompt: "write then hang during continuation" },
        })
        const continuationMessages = yield* receiveUntil(
          appServer,
          (messages) =>
            messages.some((message) => isResponse(message, 4)) &&
            messages.some((message) => isNotification(message, "turn/toolApprovalRequested")),
        )
        const continuationApproval = notificationParams(continuationMessages, "turn/toolApprovalRequested")

        yield* appServer.send({
          jsonrpc: "2.0",
          id: 5,
          method: "turn/toolApproval/respond",
          params: {
            sessionId: sessionResult.sessionId,
            approvalId: stringField(continuationApproval, "approvalId"),
            decision: "accept",
          },
        })
        yield* receiveUntil(
          appServer,
          (messages) =>
            messages.some((message) => isResponse(message, 5)) &&
            messages.some((message) => isNotification(message, "turn/toolCallCompleted")),
        )

        yield* appServer.send({
          jsonrpc: "2.0",
          id: 6,
          method: "turn/cancel",
          params: { sessionId: sessionResult.sessionId },
        })
        const cancelledContinuationMessages = yield* receiveUntil(
          appServer,
          (messages) =>
            messages.some((message) => isResponse(message, 6)) &&
            messages.some((message) => isNotification(message, "turn/completed")),
        )
        expect(cancelledContinuationMessages).toContainEqual(
          expect.objectContaining({
            jsonrpc: "2.0",
            id: 6,
            result: expect.objectContaining({
              cancelled: true,
              active: true,
            }),
          }),
        )
        expect(notificationParamList(cancelledContinuationMessages, "turn/completed")).toEqual([
          expect.objectContaining({
            sessionId: sessionResult.sessionId,
            status: "cancelled",
          }),
        ])

        releaseContinuation()
        yield* llm.reset
        yield* llm.text("after cancel ok")
        yield* appServer.send({
          jsonrpc: "2.0",
          id: 7,
          method: "turn/start",
          params: { sessionId: sessionResult.sessionId, prompt: "continue after cancellation" },
        })
        const afterCancelMessages = yield* receiveUntil(
          appServer,
          (messages) =>
            messages.some((message) => isResponse(message, 7)) &&
            messages.some((message) => isNotification(message, "turn/completed")),
        )
        expect(afterCancelMessages).toContainEqual(
          expect.objectContaining({
            jsonrpc: "2.0",
            id: 7,
            result: expect.objectContaining({
              accepted: true,
            }),
          }),
        )
        expect(afterCancelMessages).toContainEqual(
          expect.objectContaining({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: expect.objectContaining({
              status: "completed",
              content: "after cancel ok",
            }),
          }),
        )

        yield* llm.reset
        let releaseQueuedFirst!: () => void
        const queuedFirst = new Promise<void>((resolve) => {
          releaseQueuedFirst = resolve
        })
        yield* llm.hold("queued first ok", queuedFirst)
        yield* appServer.send({
          jsonrpc: "2.0",
          id: 8,
          method: "turn/start",
          params: { sessionId: sessionResult.sessionId, prompt: "hold first queued test turn" },
        })
        const firstQueuedMessages = yield* receiveUntil(appServer, (messages) =>
          messages.some((message) => isResponse(message, 8)),
        )
        const firstQueuedResponse = objectRecord(objectRecord(responseWithId(firstQueuedMessages, 8))?.result)
        if (!firstQueuedResponse) throw new Error("first queued test turn did not return a result")
        const firstQueuedTurnId = stringField(firstQueuedResponse, "turnId")
        if (!firstQueuedTurnId) throw new Error("first queued test turn did not return a turn id")

        yield* llm.text("queued second ok")
        yield* appServer.send({
          jsonrpc: "2.0",
          id: 9,
          method: "turn/start",
          params: { sessionId: sessionResult.sessionId, prompt: "run after first queued test turn" },
        })
        const secondQueuedMessages = yield* receiveUntil(appServer, (messages) =>
          messages.some((message) => isResponse(message, 9)),
        )
        const secondQueuedResponse = objectRecord(objectRecord(responseWithId(secondQueuedMessages, 9))?.result)
        if (!secondQueuedResponse) throw new Error("second queued test turn did not return a result")
        const secondQueuedTurnId = stringField(secondQueuedResponse, "turnId")
        if (!secondQueuedTurnId) throw new Error("second queued test turn did not return a turn id")
        expect(secondQueuedResponse).toMatchObject({
          accepted: true,
          delivery: "queue",
        })

        releaseQueuedFirst()
        const queuedTurnMessages = yield* receiveUntil(appServer, (messages) => {
          const completed = notificationParamList(messages, "turn/completed")
          return (
            completed.some((message) => stringField(message, "turnId") === firstQueuedTurnId) &&
            completed.some((message) => stringField(message, "turnId") === secondQueuedTurnId)
          )
        })
        expect(notificationParamList(queuedTurnMessages, "turn/completed")).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              turnId: firstQueuedTurnId,
              status: "completed",
              content: "queued first ok",
            }),
            expect.objectContaining({
              turnId: secondQueuedTurnId,
              status: "completed",
              content: "queued second ok",
            }),
          ]),
        )

        yield* appServer.send({ jsonrpc: "2.0", id: 10, method: "server/shutdown" })
        const shutdownMessages = yield* receiveUntil(appServer, (messages) =>
          messages.some((message) => isResponse(message, 10)),
        )
        const shutdown = responseWithId(shutdownMessages, 10)
        expect(shutdown).toEqual({
          jsonrpc: "2.0",
          id: 10,
          result: { ok: true },
        })

        const code = yield* Effect.promise(() => appServer.exited).pipe(Effect.timeout(Duration.seconds(30)))
        expect(code).toBe(0)
      }),
    120_000,
  )
})

test("app-server handles approval response aliases", async () => {
  const replies: unknown[] = []
  const response = await handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "turn/toolApproval/respond",
      params: {
        providerSessionId: "ses_test",
        approvalId: "per_test",
        decision: "accept",
      },
    }),
    {
      listProviders: async () => ({ data: [] }),
      listModels: async () => ({ data: [] }),
      listModelVariants: async () => ({ data: [] }),
      createSession: async () => {
        throw new Error("unused")
      },
      listSessions: async () => ({ data: [] }),
      getSessionStatus: async () => {
        throw new Error("unused")
      },
      resumeSession: async () => {
        throw new Error("unused")
      },
      startTurn: async () => {
        throw new Error("unused")
      },
      cancelTurn: async () => {
        throw new Error("unused")
      },
      respondToolApproval: async (params) => {
        replies.push(params)
        return {
          ok: true,
          sessionId: params.sessionId,
          providerSessionId: params.sessionId,
          threadId: params.sessionId,
          requestId: params.requestId,
          approvalId: params.requestId,
          reply: params.reply,
        }
      },
      respondUserInput: async () => {
        throw new Error("unused")
      },
      rejectUserInput: async () => {
        throw new Error("unused")
      },
    },
  )

  expect(replies).toEqual([{ sessionId: "ses_test", requestId: "per_test", reply: "once", message: undefined }])
  expect(response).toEqual({
    response: {
      jsonrpc: "2.0",
      id: 1,
      result: {
        ok: true,
        sessionId: "ses_test",
        providerSessionId: "ses_test",
        threadId: "ses_test",
        requestId: "per_test",
        approvalId: "per_test",
        reply: "once",
      },
    },
  })
})

test("app-server forwards session instruction params", async () => {
  const turns: unknown[] = []
  const response = await handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "turn/start",
      params: {
        providerSessionId: "ses_test",
        prompt: "hello",
        hostPlatform: "ALS",
        builtinInstructions: "app-server",
        developerInstructions: [{ id: "als:developer_instructions", text: "Use the project style." }],
        userDeveloperInstructions: [{ id: "als:user_developer_instructions", text: "Prefer small patches." }],
      },
    }),
    {
      listProviders: async () => ({ data: [] }),
      listModels: async () => ({ data: [] }),
      listModelVariants: async () => ({ data: [] }),
      createSession: async () => {
        throw new Error("unused")
      },
      listSessions: async () => ({ data: [] }),
      getSessionStatus: async () => {
        throw new Error("unused")
      },
      resumeSession: async () => {
        throw new Error("unused")
      },
      startTurn: async (params) => {
        turns.push(params)
        return {
          accepted: true,
          sessionId: params.sessionId,
          providerSessionId: params.sessionId,
          threadId: params.sessionId,
          turnId: params.turnId ?? "turn_test",
          messageId: params.messageId ?? "msg_test",
          delivery: params.delivery ?? "steer",
        }
      },
      cancelTurn: async () => {
        throw new Error("unused")
      },
      respondToolApproval: async () => {
        throw new Error("unused")
      },
      respondUserInput: async () => {
        throw new Error("unused")
      },
      rejectUserInput: async () => {
        throw new Error("unused")
      },
    },
  )

  expect(turns).toEqual([
    expect.objectContaining({
      sessionId: "ses_test",
      prompt: "hello",
      hostPlatform: "ALS",
      builtinInstructions: "app-server",
      developerInstructions: [{ id: "als:developer_instructions", text: "Use the project style." }],
      userDeveloperInstructions: [{ id: "als:user_developer_instructions", text: "Prefer small patches." }],
    }),
  ])
  expect(response).toMatchObject({
    response: {
      jsonrpc: "2.0",
      id: 1,
      result: {
        accepted: true,
        sessionId: "ses_test",
      },
    },
  })
})

test("app-server forwards session messages params", async () => {
  const requests: unknown[] = []
  const response = await handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session/messages",
      params: {
        providerSessionId: "ses_test",
        limit: 50,
        order: "asc",
        cursor: {
          messageId: "msg_test",
          direction: "next",
        },
      },
    }),
    {
      listProviders: async () => ({ data: [] }),
      listModels: async () => ({ data: [] }),
      listModelVariants: async () => ({ data: [] }),
      createSession: async () => {
        throw new Error("unused")
      },
      listSessions: async () => ({ data: [] }),
      sessionMessages: async (params) => {
        requests.push(params)
        return {
          sessionId: params.sessionId,
          providerSessionId: params.sessionId,
          threadId: params.sessionId,
          data: [],
          messages: [],
        }
      },
      getSessionStatus: async () => {
        throw new Error("unused")
      },
      resumeSession: async () => {
        throw new Error("unused")
      },
      startTurn: async () => {
        throw new Error("unused")
      },
      cancelTurn: async () => {
        throw new Error("unused")
      },
      respondToolApproval: async () => {
        throw new Error("unused")
      },
      respondUserInput: async () => {
        throw new Error("unused")
      },
      rejectUserInput: async () => {
        throw new Error("unused")
      },
    },
  )

  expect(requests).toEqual([
    {
      sessionId: "ses_test",
      limit: 50,
      order: "asc",
      cursor: {
        id: "msg_test",
        direction: "next",
      },
    },
  ])
  expect(response).toEqual({
    response: {
      jsonrpc: "2.0",
      id: 1,
      result: {
        sessionId: "ses_test",
        providerSessionId: "ses_test",
        threadId: "ses_test",
        data: [],
        messages: [],
      },
    },
  })
})

test("app-server rejects malformed session instruction params", async () => {
  const response = await handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session/create",
      params: {
        cwd: "/tmp",
        developerInstructions: [{ id: "missing-text" }],
      },
    }),
    {
      listProviders: async () => ({ data: [] }),
      listModels: async () => ({ data: [] }),
      listModelVariants: async () => ({ data: [] }),
      createSession: async () => {
        throw new Error("unused")
      },
      listSessions: async () => ({ data: [] }),
      getSessionStatus: async () => {
        throw new Error("unused")
      },
      resumeSession: async () => {
        throw new Error("unused")
      },
      startTurn: async () => {
        throw new Error("unused")
      },
      cancelTurn: async () => {
        throw new Error("unused")
      },
      respondToolApproval: async () => {
        throw new Error("unused")
      },
      respondUserInput: async () => {
        throw new Error("unused")
      },
      rejectUserInput: async () => {
        throw new Error("unused")
      },
    },
  )

  expect(response).toEqual({
    response: {
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32602,
        message: "Invalid params",
      },
    },
  })
})

test("app-server forwards typed MCP server params", async () => {
  const sessions: unknown[] = []
  const turns: unknown[] = []
  const mcpServers = {
    "agent-pty-blocks": {
      type: "local",
      command: ["python3", "/tmp/mcp_agent_pty_server.py"],
      environment: {
        CONVERSATION_ID: "conv_test",
        PWD: "/tmp",
        AGENT_LOG_SERVER_ORIGIN: "http://127.0.0.1:12459",
      },
      cwd: "/tmp",
    },
    "te2-mcp": {
      type: "remote",
      url: "http://127.0.0.1:12459/te2_mcp_http",
      transport: "streamable-http",
    },
  }

  const created = await handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session/create",
      params: {
        cwd: "/tmp",
        mcpServers,
      },
    }),
    {
      listProviders: async () => ({ data: [] }),
      listModels: async () => ({ data: [] }),
      listModelVariants: async () => ({ data: [] }),
      createSession: async (params) => {
        sessions.push(params)
        return {
          sessionId: "ses_test",
          providerSessionId: "ses_test",
          threadId: "ses_test",
          cwd: params.cwd,
        }
      },
      listSessions: async () => ({ data: [] }),
      getSessionStatus: async () => {
        throw new Error("unused")
      },
      resumeSession: async () => {
        throw new Error("unused")
      },
      startTurn: async (params) => {
        turns.push(params)
        return {
          accepted: true,
          sessionId: params.sessionId,
          providerSessionId: params.sessionId,
          threadId: params.sessionId,
          turnId: params.turnId ?? "turn_test",
          messageId: params.messageId ?? "msg_test",
          delivery: params.delivery ?? "steer",
        }
      },
      cancelTurn: async () => {
        throw new Error("unused")
      },
      respondToolApproval: async () => {
        throw new Error("unused")
      },
      respondUserInput: async () => {
        throw new Error("unused")
      },
      rejectUserInput: async () => {
        throw new Error("unused")
      },
    },
  )

  const started = await handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "turn/start",
      params: {
        sessionId: "ses_test",
        prompt: "hello",
        mcpServers,
      },
    }),
    {
      listProviders: async () => ({ data: [] }),
      listModels: async () => ({ data: [] }),
      listModelVariants: async () => ({ data: [] }),
      createSession: async () => {
        throw new Error("unused")
      },
      listSessions: async () => ({ data: [] }),
      getSessionStatus: async () => {
        throw new Error("unused")
      },
      resumeSession: async () => {
        throw new Error("unused")
      },
      startTurn: async (params) => {
        turns.push(params)
        return {
          accepted: true,
          sessionId: params.sessionId,
          providerSessionId: params.sessionId,
          threadId: params.sessionId,
          turnId: params.turnId ?? "turn_test",
          messageId: params.messageId ?? "msg_test",
          delivery: params.delivery ?? "steer",
        }
      },
      cancelTurn: async () => {
        throw new Error("unused")
      },
      respondToolApproval: async () => {
        throw new Error("unused")
      },
      respondUserInput: async () => {
        throw new Error("unused")
      },
      rejectUserInput: async () => {
        throw new Error("unused")
      },
    },
  )

  expect(sessions).toEqual([
    expect.objectContaining({
      cwd: "/tmp",
      mcpServers,
    }),
  ])
  expect(turns).toEqual([
    expect.objectContaining({
      sessionId: "ses_test",
      prompt: "hello",
      mcpServers,
    }),
  ])
  expect(created).toMatchObject({
    response: {
      jsonrpc: "2.0",
      id: 1,
      result: {
        sessionId: "ses_test",
      },
    },
  })
  expect(started).toMatchObject({
    response: {
      jsonrpc: "2.0",
      id: 2,
      result: {
        accepted: true,
        sessionId: "ses_test",
      },
    },
  })
})

test("app-server rejects malformed MCP server params", async () => {
  const response = await handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "turn/start",
      params: {
        sessionId: "ses_test",
        prompt: "hello",
        mcpServers: {
          "te2-mcp": {
            type: "remote",
          },
        },
      },
    }),
    {
      listProviders: async () => ({ data: [] }),
      listModels: async () => ({ data: [] }),
      listModelVariants: async () => ({ data: [] }),
      createSession: async () => {
        throw new Error("unused")
      },
      listSessions: async () => ({ data: [] }),
      getSessionStatus: async () => {
        throw new Error("unused")
      },
      resumeSession: async () => {
        throw new Error("unused")
      },
      startTurn: async () => {
        throw new Error("unused")
      },
      cancelTurn: async () => {
        throw new Error("unused")
      },
      respondToolApproval: async () => {
        throw new Error("unused")
      },
      respondUserInput: async () => {
        throw new Error("unused")
      },
      rejectUserInput: async () => {
        throw new Error("unused")
      },
    },
  )

  expect(response).toEqual({
    response: {
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32602,
        message: "Invalid params",
      },
    },
  })
})

test("app-server preserves tagged internal error details", async () => {
  const response = await handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "model/list",
      params: {},
    }),
    {
      listProviders: async () => ({ data: [] }),
      listModels: async () => {
        throw {
          _tag: "Session.ModelUnavailableError",
          providerID: "test",
          modelID: "missing",
        }
      },
      listModelVariants: async () => ({ data: [] }),
      createSession: async () => {
        throw new Error("unused")
      },
      listSessions: async () => ({ data: [] }),
      getSessionStatus: async () => {
        throw new Error("unused")
      },
      resumeSession: async () => {
        throw new Error("unused")
      },
      startTurn: async () => {
        throw new Error("unused")
      },
      cancelTurn: async () => {
        throw new Error("unused")
      },
      respondToolApproval: async () => {
        throw new Error("unused")
      },
      respondUserInput: async () => {
        throw new Error("unused")
      },
      rejectUserInput: async () => {
        throw new Error("unused")
      },
    },
  )

  expect(response).toMatchObject({
    response: {
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32603,
        message:
          'model/list failed: Session.ModelUnavailableError {"providerID":"test","modelID":"missing"}',
        data: {
          method: "model/list",
          cause: {
            tag: "Session.ModelUnavailableError",
            details: {
              providerID: "test",
              modelID: "missing",
            },
          },
        },
      },
    },
  })
})

test("app-server translates session errors into failed turn completion", () => {
  const activeTurns = new Map<string, ActiveTurn>([
    [
      "ses_test",
      {
        turnId: "turn_test",
        sessionId: "ses_test",
        content: ["partial"],
        reasoning: ["thought"],
      },
    ],
  ])

  const messages = turnNotifications(activeTurns, {
    type: "session.error",
    properties: {
      sessionID: "ses_test",
      error: { type: "unknown", message: "Model not found: openrouter/google/gemma-4-31b-it" },
    },
  } as Parameters<typeof turnNotifications>[1])

  expect(activeTurns.has("ses_test")).toBe(false)
  expect(messages).toEqual([
    {
      jsonrpc: "2.0",
      method: "turn/error",
      params: {
        turnId: "turn_test",
        sessionId: "ses_test",
        providerSessionId: "ses_test",
        threadId: "ses_test",
        error: { type: "unknown", message: "Model not found: openrouter/google/gemma-4-31b-it" },
      },
    },
    {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        turnId: "turn_test",
        sessionId: "ses_test",
        providerSessionId: "ses_test",
        threadId: "ses_test",
        status: "failed",
        content: "partial",
        reasoning: "thought",
        error: { type: "unknown", message: "Model not found: openrouter/google/gemma-4-31b-it" },
      },
    },
  ])
})

test("app-server translates route part deltas without final snapshot duplication", () => {
  const activeTurns = new Map<string, ActiveTurn>([
    [
      "ses_test",
      {
        turnId: "turn_test",
        sessionId: "ses_test",
        content: [],
        reasoning: [],
        assistantMessageIds: new Set(["msg_test"]),
      },
    ],
  ])

  const created = turnNotifications(activeTurns, {
    type: "message.part.updated",
    properties: {
      sessionID: "ses_test",
      part: {
        id: "prt_text",
        messageID: "msg_test",
        sessionID: "ses_test",
        type: "text",
        text: "",
      },
    },
  } as Parameters<typeof turnNotifications>[1])
  const streamed = turnNotifications(activeTurns, {
    type: "message.part.delta",
    properties: {
      sessionID: "ses_test",
      messageID: "msg_test",
      partID: "prt_text",
      field: "text",
      delta: "hello",
    },
  } as Parameters<typeof turnNotifications>[1])
  const finalized = turnNotifications(activeTurns, {
    type: "message.part.updated",
    properties: {
      sessionID: "ses_test",
      part: {
        id: "prt_text",
        messageID: "msg_test",
        sessionID: "ses_test",
        type: "text",
        text: "hello",
      },
    },
  } as Parameters<typeof turnNotifications>[1])

  expect(created).toEqual([])
  expect(streamed).toEqual([
    {
      jsonrpc: "2.0",
      method: "turn/contentDelta",
      params: {
        turnId: "turn_test",
        sessionId: "ses_test",
        providerSessionId: "ses_test",
        threadId: "ses_test",
        delta: "hello",
        textId: "prt_text",
      },
    },
  ])
  expect(finalized).toEqual([])
})

test("app-server waits for running tool input before emitting tool requests", () => {
  const activeTurns = new Map<string, ActiveTurn>([
    [
      "ses_test",
      {
        turnId: "turn_test",
        sessionId: "ses_test",
        content: [],
        reasoning: [],
        assistantMessageIds: new Set(["msg_test"]),
      },
    ],
  ])

  const pending = turnNotifications(activeTurns, {
    type: "message.part.updated",
    properties: {
      sessionID: "ses_test",
      part: {
        id: "prt_tool",
        messageID: "msg_test",
        sessionID: "ses_test",
        type: "tool",
        tool: "read",
        callID: "call_read",
        state: {
          status: "pending",
          input: {},
        },
      },
    },
  } as Parameters<typeof turnNotifications>[1])
  const running = turnNotifications(activeTurns, {
    type: "message.part.updated",
    properties: {
      sessionID: "ses_test",
      part: {
        id: "prt_tool",
        messageID: "msg_test",
        sessionID: "ses_test",
        type: "tool",
        tool: "read",
        callID: "call_read",
        state: {
          status: "running",
          input: { filePath: "/workspace/example.txt" },
        },
      },
    },
  } as Parameters<typeof turnNotifications>[1])

  expect(pending).toEqual([])
  expect(running).toEqual([
    {
      jsonrpc: "2.0",
      method: "turn/toolCallRequested",
      params: {
        turnId: "turn_test",
        sessionId: "ses_test",
        providerSessionId: "ses_test",
        threadId: "ses_test",
        toolCallId: "call_read",
        messageId: "msg_test",
        tool: "read",
        input: { filePath: "/workspace/example.txt" },
        raw: undefined,
      },
    },
  ])
})

test("app-server handles user input response params", async () => {
  const replies: unknown[] = []
  const response = await handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "turn/userInput/respond",
      params: {
        providerSessionId: "ses_test",
        requestId: "que_test",
        answers: [["Small patch"], ["Use tests", "Update docs"]],
      },
    }),
    {
      listProviders: async () => ({ data: [] }),
      listModels: async () => ({ data: [] }),
      listModelVariants: async () => ({ data: [] }),
      createSession: async () => {
        throw new Error("unused")
      },
      listSessions: async () => ({ data: [] }),
      getSessionStatus: async () => {
        throw new Error("unused")
      },
      resumeSession: async () => {
        throw new Error("unused")
      },
      startTurn: async () => {
        throw new Error("unused")
      },
      cancelTurn: async () => {
        throw new Error("unused")
      },
      respondToolApproval: async () => {
        throw new Error("unused")
      },
      respondUserInput: async (params) => {
        replies.push(params)
        return {
          ok: true,
          sessionId: params.sessionId,
          providerSessionId: params.sessionId,
          threadId: params.sessionId,
          requestId: params.requestId,
          answers: params.answers,
        }
      },
      rejectUserInput: async () => {
        throw new Error("unused")
      },
    },
  )

  expect(replies).toEqual([
    {
      sessionId: "ses_test",
      requestId: "que_test",
      answers: [["Small patch"], ["Use tests", "Update docs"]],
    },
  ])
  expect(response).toEqual({
    response: {
      jsonrpc: "2.0",
      id: 1,
      result: {
        ok: true,
        sessionId: "ses_test",
        providerSessionId: "ses_test",
        threadId: "ses_test",
        requestId: "que_test",
        answers: [["Small patch"], ["Use tests", "Update docs"]],
      },
    },
  })
})

test("app-server rejects malformed user input answers", async () => {
  const response = await handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "turn/userInput/respond",
      params: {
        providerSessionId: "ses_test",
        requestId: "que_test",
        answers: ["Small patch"],
      },
    }),
    {
      listProviders: async () => ({ data: [] }),
      listModels: async () => ({ data: [] }),
      listModelVariants: async () => ({ data: [] }),
      createSession: async () => {
        throw new Error("unused")
      },
      listSessions: async () => ({ data: [] }),
      getSessionStatus: async () => {
        throw new Error("unused")
      },
      resumeSession: async () => {
        throw new Error("unused")
      },
      startTurn: async () => {
        throw new Error("unused")
      },
      cancelTurn: async () => {
        throw new Error("unused")
      },
      respondToolApproval: async () => {
        throw new Error("unused")
      },
      respondUserInput: async () => {
        throw new Error("unused")
      },
      rejectUserInput: async () => {
        throw new Error("unused")
      },
    },
  )

  expect(response).toEqual({
    response: {
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32602,
        message: "Invalid params",
      },
    },
  })
})

test("app-server translates question events into user input notifications", () => {
  const activeTurns = new Map<string, ActiveTurn>([
    [
      "ses_test",
      {
        turnId: "turn_test",
        sessionId: "ses_test",
        content: [],
        reasoning: [],
      },
    ],
  ])

  const asked = turnNotifications(activeTurns, {
    type: "question.asked",
    properties: {
      id: "que_test",
      sessionID: "ses_test",
      questions: [
        {
          header: "Scope",
          question: "Which approach should I use?",
          options: [{ label: "Small patch", description: "Keep changes narrow" }],
          multiple: false,
          custom: true,
        },
      ],
      tool: { messageID: "msg_test", callID: "call_question" },
    },
  } as Parameters<typeof turnNotifications>[1])
  expect(asked).toEqual([
    {
      jsonrpc: "2.0",
      method: "turn/userInputRequested",
      params: {
        turnId: "turn_test",
        sessionId: "ses_test",
        providerSessionId: "ses_test",
        threadId: "ses_test",
        requestId: "que_test",
        questionId: "que_test",
        questions: [
          {
            header: "Scope",
            question: "Which approach should I use?",
            options: [{ label: "Small patch", description: "Keep changes narrow" }],
            multiple: false,
            custom: true,
          },
        ],
        tool: { messageID: "msg_test", callID: "call_question" },
        toolCallId: "call_question",
        messageId: "msg_test",
      },
    },
  ])

  const replied = turnNotifications(activeTurns, {
    type: "question.replied",
    properties: {
      sessionID: "ses_test",
      requestID: "que_test",
      answers: [["Small patch"]],
    },
  } as Parameters<typeof turnNotifications>[1])
  expect(replied).toEqual([
    {
      jsonrpc: "2.0",
      method: "turn/userInputResolved",
      params: {
        turnId: "turn_test",
        sessionId: "ses_test",
        providerSessionId: "ses_test",
        threadId: "ses_test",
        requestId: "que_test",
        questionId: "que_test",
        status: "answered",
        answers: [["Small patch"]],
      },
    },
  ])
})

test("app-server translates route token usage and idle completion", () => {
  const activeTurns = new Map<string, ActiveTurn>([
    [
      "ses_test",
      {
        turnId: "turn_test",
        sessionId: "ses_test",
        content: ["done"],
        reasoning: ["thinking"],
        contextWindow: 1000,
        assistantMessageIds: new Set(["msg_test"]),
      },
    ],
  ])

  const usage = turnNotifications(activeTurns, {
    type: "message.part.updated",
    properties: {
      sessionID: "ses_test",
      part: {
        id: "part_step",
        sessionID: "ses_test",
        messageID: "msg_test",
        type: "step-finish",
        reason: "stop",
        cost: 0.01,
        tokens: {
          input: 120,
          output: 30,
          reasoning: 10,
          cache: { read: 40, write: 5 },
        },
      },
    },
  } as Parameters<typeof turnNotifications>[1])

  expect(activeTurns.has("ses_test")).toBe(true)
  expect(usage).toEqual([
    {
      jsonrpc: "2.0",
      method: "turn/usage",
      params: {
        turnId: "turn_test",
        sessionId: "ses_test",
        providerSessionId: "ses_test",
        threadId: "ses_test",
        tokens: {
          input: 120,
          output: 30,
          reasoning: 10,
          cache: { read: 40, write: 5 },
        },
        usage: {
          total: 205,
          input: 120,
          inputTokens: 120,
          input_tokens: 120,
          output: 30,
          outputTokens: 30,
          output_tokens: 30,
          reasoning: 10,
          reasoningTokens: 10,
          reasoning_tokens: 10,
          cacheRead: 40,
          cache_read: 40,
          cachedInputTokens: 40,
          cacheWrite: 5,
          cache_write: 5,
          contextUsed: 165,
          context_used: 165,
          contextWindow: 1000,
          context_window: 1000,
          contextPercent: 0.165,
          context_percent: 0.165,
        },
        contextWindow: 1000,
        context_window: 1000,
      },
    },
  ])

  const completed = turnNotifications(activeTurns, {
    type: "session.status",
    properties: {
      sessionID: "ses_test",
      status: { type: "idle" },
    },
  } as Parameters<typeof turnNotifications>[1])

  expect(activeTurns.has("ses_test")).toBe(false)
  expect(completed).toEqual([
    {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        turnId: "turn_test",
        sessionId: "ses_test",
        providerSessionId: "ses_test",
        threadId: "ses_test",
        status: "completed",
        content: "done",
        reasoning: "thinking",
      },
    },
  ])
})

function receiveUntil(appServer: AppServerHandle, done: (messages: unknown[]) => boolean) {
  return Effect.gen(function* () {
    const messages: unknown[] = []
    for (let index = 0; index < 200; index += 1) {
      const message = yield* appServer.receive.pipe(
        Effect.timeout(Duration.seconds(40)),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(new Error(`Timed out waiting for app-server messages:\n${JSON.stringify(messages, null, 2)}`)),
        ),
      )
      messages.push(message)
      if (done(messages)) return messages
    }
    throw new Error(`Timed out waiting for app-server messages:\n${JSON.stringify(messages, null, 2)}`)
  })
}

function isResponse(message: unknown, id: number) {
  const item = objectRecord(message)
  return item !== undefined && item.id === id
}

function responseWithId(messages: unknown[], id: number) {
  const message = messages.find((message) => isResponse(message, id))
  if (!message) throw new Error(`Missing response id: ${id}`)
  return message
}

function isNotification(message: unknown, method: string) {
  const item = objectRecord(message)
  return item !== undefined && item.method === method
}

function notificationParams(messages: unknown[], method: string) {
  const message = messages.find((message) => isNotification(message, method))
  const item = objectRecord(message)
  const params = objectRecord(item?.params)
  if (!params) throw new Error(`Missing notification params: ${method}`)
  return params
}

function notificationParamList(messages: unknown[], method: string) {
  return messages
    .filter((message) => isNotification(message, method))
    .map((message) => objectRecord(objectRecord(message)?.params))
    .filter((params): params is Record<string, unknown> => params !== undefined)
}

function stringField(value: Record<string, unknown>, field: string) {
  const item = value[field]
  if (typeof item !== "string") throw new Error(`Missing string field: ${field}`)
  return item
}

function objectRecord(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  return undefined
}
