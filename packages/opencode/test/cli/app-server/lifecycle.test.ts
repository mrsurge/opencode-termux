import { describe, expect, test } from "bun:test"
import { Duration, Effect } from "effect"
import { type AppServerHandle, cliIt } from "../../lib/cli-process"
import { handleLine, turnNotifications, type ActiveTurn } from "../../../src/cli/cmd/app-server"

describe("opencode app-server subprocess", () => {
  cliIt.live(
    "initializes and shuts down over stdio JSON-RPC",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Bun.write(
            `${home}/opencode.json`,
            JSON.stringify({
              providers: {
                test: {
                  name: "Test",
                  api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: llm.url },
                  request: { body: { apiKey: "test-key" } },
                  models: {
                    "test-model": {
                      name: "Test Model",
                      capabilities: { tools: true, input: ["text"], output: ["text"] },
                      limit: { context: 100_000, output: 10_000 },
                      cost: { input: 0, output: 0 },
                      variants: [
                        { id: "low", body: { reasoningEffort: "low" } },
                        { id: "high", body: { reasoningEffort: "high" } },
                      ],
                    },
                  },
                },
              },
              permissions: [{ action: "edit", resource: "*", effect: "ask" }],
            }),
          ),
        )
        const appServer = yield* opencode.appServer({ env: { OPENCODE_DISABLE_PROJECT_CONFIG: "0" } })

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
          result: {
            default: "test",
          },
        })
        expect((providers as { result: { data: unknown[] } }).result.data).toContainEqual(
          expect.objectContaining({
            id: "test",
            value: "test",
            name: "Test",
            label: "Test",
            displayName: "Test",
            defaultModel: "test-model",
            source: "catalog",
          }),
        )

        yield* appServer.send({ jsonrpc: "2.0", id: 3, method: "model/list", params: { provider: "test" } })
        const models = yield* appServer.receive.pipe(Effect.timeout(Duration.seconds(10)))
        expect(models).toMatchObject({
          jsonrpc: "2.0",
          id: 3,
          result: {
            default: "test/test-model",
            data: [
              {
                id: "test/test-model",
                value: "test/test-model",
                provider: "test",
                providerID: "test",
                model: "test-model",
                modelID: "test-model",
                name: "Test Model",
                label: "Test Model (Test)",
                displayName: "Test Model",
                family: "test",
                supportedReasoningEfforts: [
                  { id: "low", value: "low", label: "low", variant: "low", reasoningEffort: "low" },
                  { id: "high", value: "high", label: "high", variant: "high", reasoningEffort: "high" },
                ],
                defaultReasoningEffort: "low",
                features: {
                  thinking: true,
                  multimodalToolUse: false,
                },
              },
            ],
          },
        })

        yield* appServer.send({
          jsonrpc: "2.0",
          id: 40,
          method: "model/variant/list",
          params: { provider: "test", model: "test-model" },
        })
        const variants = yield* appServer.receive.pipe(Effect.timeout(Duration.seconds(10)))
        expect(variants).toMatchObject({
          jsonrpc: "2.0",
          id: 40,
          result: {
            data: [
              { id: "low", value: "low", label: "low", variant: "low", reasoningEffort: "low" },
              { id: "high", value: "high", label: "high", variant: "high", reasoningEffort: "high" },
            ],
            default: "low",
          },
        })

        yield* appServer.send({
          jsonrpc: "2.0",
          id: 4,
          method: "session/create",
          params: { cwd: home, provider: "test", model: "test-model", reasoningEffort: "high" },
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
        const invalidVariant = yield* appServer.receive.pipe(Effect.timeout(Duration.seconds(10)))
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
        const cancelled = yield* appServer.receive.pipe(Effect.timeout(Duration.seconds(10)))
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

        yield* llm.tool("write", { path: "approval.txt", content: "approved\n" })
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
          resources: ["approval.txt"],
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
                operation: "write",
                resource: "approval.txt",
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
        const staleApproval = yield* appServer.receive.pipe(Effect.timeout(Duration.seconds(10)))
        expect(staleApproval).toEqual({
          jsonrpc: "2.0",
          id: 12,
          error: {
            code: -32040,
            message: "Permission request not found: per_missing",
          },
        })

        yield* llm.tool("write", { path: "reject.txt", content: "rejected\n" })
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

        yield* llm.tool("write", { path: "always-first.txt", content: "always first\n" })
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

        yield* llm.tool("write", { path: "always-second.txt", content: "always second\n" })
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
                operation: "write",
                resource: "always-second.txt",
              }),
            }),
          }),
        )

        yield* appServer.send({ jsonrpc: "2.0", id: 18, method: "server/shutdown" })
        const shutdown = yield* appServer.receive.pipe(Effect.timeout(Duration.seconds(5)))
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
        yield* Effect.promise(() =>
          Bun.write(
            `${home}/opencode.json`,
            JSON.stringify({
              providers: {
                test: {
                  name: "Test",
                  api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: llm.url },
                  request: { body: { apiKey: "test-key" } },
                  models: {
                    "test-model": {
                      name: "Test Model",
                      capabilities: { tools: true, input: ["text"], output: ["text"] },
                      limit: { context: 100_000, output: 10_000 },
                      cost: { input: 0, output: 0 },
                    },
                  },
                },
              },
              permissions: [{ action: "edit", resource: "*", effect: "ask" }],
            }),
          ),
        )
        const appServer = yield* opencode.appServer({ env: { OPENCODE_DISABLE_PROJECT_CONFIG: "0" } })

        yield* appServer.send({
          jsonrpc: "2.0",
          id: 1,
          method: "session/create",
          params: { cwd: home, provider: "test", model: "test-model" },
        })
        const created = yield* appServer.receive.pipe(Effect.timeout(Duration.seconds(30)))
        const sessionResult = (created as { result: { sessionId: string } }).result

        yield* llm.tool("write", { path: "cancel-approval.txt", content: "cancelled\n" })
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

        yield* llm.tool("write", { path: "cancel-continuation.txt", content: "before continuation\n" })
        yield* llm.hang
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

        yield* appServer.send({ jsonrpc: "2.0", id: 8, method: "server/shutdown" })
        const shutdown = yield* appServer.receive.pipe(Effect.timeout(Duration.seconds(5)))
        expect(shutdown).toEqual({
          jsonrpc: "2.0",
          id: 8,
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
    data: {
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
    type: "question.v2.asked",
    data: {
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
    type: "question.v2.replied",
    data: {
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

test("app-server includes token usage and context window on turn completion", () => {
  const activeTurns = new Map<string, ActiveTurn>([
    [
      "ses_test",
      {
        turnId: "turn_test",
        sessionId: "ses_test",
        content: ["done"],
        reasoning: ["thinking"],
        contextWindow: 1000,
      },
    ],
  ])

  const messages = turnNotifications(activeTurns, {
    type: "session.next.step.ended",
    data: {
      sessionID: "ses_test",
      assistantMessageID: "msg_test",
      finish: "stop",
      cost: 0.01,
      tokens: {
        input: 120,
        output: 30,
        reasoning: 10,
        cache: { read: 40, write: 5 },
      },
    },
  } as Parameters<typeof turnNotifications>[1])

  expect(activeTurns.has("ses_test")).toBe(false)
  expect(messages).toEqual([
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
        finish: "stop",
        cost: 0.01,
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
})

function receiveUntil(appServer: AppServerHandle, done: (messages: unknown[]) => boolean) {
  return Effect.gen(function* () {
    const messages: unknown[] = []
    for (let index = 0; index < 20; index += 1) {
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
