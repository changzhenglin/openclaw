// Usage reporting tests cover run-level metadata attribution, runtime plugin
// bootstrap inputs, and forwarding fields into embedded attempts.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookRunner } from "../../plugins/hooks.js";
import { createHookRunnerWithRegistry } from "../../plugins/hooks.test-helpers.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedEnsureRuntimePluginsLoadedWithRegistry,
  mockedGlobalHookRunner,
  mockedResolveModelAsync,
  mockedRunEmbeddedAttempt,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

function makeAssistantMessage(
  overrides: Partial<AssistantMessage> = {},
): NonNullable<EmbeddedRunAttemptResult["lastAssistant"]> {
  // Minimal assistant fixture lets tests override provider/model/usage without
  // recreating the full attempt result shape.
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: { input: 0, output: 0 } as AssistantMessage["usage"],
    stopReason: "end_turn" as AssistantMessage["stopReason"],
    timestamp: Date.now(),
    content: [],
    ...overrides,
  };
}

function firstAttemptInput(): Record<string, unknown> {
  // Harness calls are single-attempt in these tests; expose the first input so
  // forwarding assertions stay readable.
  const call = mockedRunEmbeddedAttempt.mock.calls[0];
  if (!call) {
    throw new Error("Expected embedded attempt");
  }
  return call[0] as Record<string, unknown>;
}

describe("runEmbeddedAgent usage reporting", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    mockedEnsureRuntimePluginsLoadedWithRegistry.mockReset();
    mockedRunEmbeddedAttempt.mockReset();
    // 生产接线用例（T5-F1）会把全局 runner mock 的 hasHooks 拨为带钩 sanity，
    // 此处复位 harness 默认（无钩）防跨用例泄漏。
    mockedGlobalHookRunner.hasHooks.mockReset();
    mockedGlobalHookRunner.hasHooks.mockReturnValue(false);
  });

  it("bootstraps runtime plugins with the resolved workspace before running", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1"],
      }),
    );

    await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-plugin-bootstrap",
    });

    // Task 3（e4c6437d1c・丙案捕获点 (b)）后 bootstrap 调用面＝WithRegistry；入参核对面不变。
    expect(mockedEnsureRuntimePluginsLoadedWithRegistry).toHaveBeenCalledWith({
      config: undefined,
      workspaceDir: "/tmp/workspace",
    });
  });

  it("forwards gateway subagent binding opt-in to runtime plugin bootstrap", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1"],
      }),
    );

    await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-gateway-bind",
      allowGatewaySubagentBinding: true,
    });

    expect(mockedEnsureRuntimePluginsLoadedWithRegistry).toHaveBeenCalledWith({
      config: undefined,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });
    expect(firstAttemptInput().allowGatewaySubagentBinding).toBe(true);
  });

  it("forwards sender identity fields into embedded attempts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1"],
      }),
    );

    await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-sender-forwarding",
      senderId: "user-123",
      senderName: "Josh Lehman",
      senderUsername: "josh",
      senderE164: "+15551234567",
    });

    const attemptInput = firstAttemptInput();
    expect(attemptInput.senderId).toBe("user-123");
    expect(attemptInput.senderName).toBe("Josh Lehman");
    expect(attemptInput.senderUsername).toBe("josh");
    expect(attemptInput.senderE164).toBe("+15551234567");
  });

  it("forwards memory flush write paths into memory-triggered attempts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
      }),
    );

    await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "flush",
      timeoutMs: 30000,
      runId: "run-memory-forwarding",
      trigger: "memory",
      memoryFlushWritePath: "memory/2026-03-10.md",
    });

    const attemptInput = firstAttemptInput();
    expect(attemptInput.trigger).toBe("memory");
    expect(attemptInput.memoryFlushWritePath).toBe("memory/2026-03-10.md");
  });

  it("reports total usage from the last turn instead of accumulated total", async () => {
    // Billing metadata uses accumulated input/output but the reported total
    // remains the final provider call total, matching last-turn usage contracts.
    // Simulate a multi-turn run result.
    // Turn 1: Input 100, Output 50. Total 150.
    // Turn 2: Input 150, Output 50. Total 200.

    // The accumulated usage (attemptUsage) will be the sum:
    // Input: 100 + 150 = 250 (Note: runEmbeddedAttempt actually returns accumulated usage)
    // Output: 50 + 50 = 100
    // Total: 150 + 200 = 350

    // The last assistant usage (lastAssistant.usage) will be Turn 2:
    // Input: 150, Output 50, Total 200.

    // We expect result.meta.agentMeta.usage.total to be 200 (last turn total).
    // The bug causes it to be 350 (accumulated total).

    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1", "Response 2"],
        lastAssistant: makeAssistantMessage({
          usage: { input: 150, output: 50, total: 200 } as unknown as AssistantMessage["usage"],
        }),
        attemptUsage: { input: 250, output: 100, total: 350 },
      }),
    );

    const result = await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-1",
    });

    // Check usage in meta
    const usage = result.meta.agentMeta?.usage;
    expect(usage?.input).toBe(250);
    expect(usage?.output).toBe(100);
    expect(usage?.total).toBe(200);

    // Check if total matches the last turn's total (200)
    // If the bug exists, it will likely be 350
    expect(usage?.total).toBe(200);
  });

  it("reports the resolved model provider when OpenClaw marks the assistant message as the native runtime", async () => {
    mockedResolveModelAsync.mockResolvedValueOnce({
      model: {
        id: "openai/gpt-5.4",
        provider: "openrouter",
        contextWindow: 200000,
        api: "openai-completions",
      },
      error: null,
      authStorage: {
        setRuntimeApiKey: vi.fn(),
      },
      modelRegistry: {},
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1"],
        lastAssistant: makeAssistantMessage({
          provider: "openclaw",
          model: "openclaw",
          usage: { input: 100, output: 50, total: 150 } as unknown as AssistantMessage["usage"],
        }),
        attemptUsage: { input: 100, output: 50, total: 150 },
      }),
    );

    const result = await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      provider: "openrouter",
      model: "openai/gpt-5.4",
      timeoutMs: 30000,
      runId: "run-provider-attribution",
    });

    expect(result.meta.agentMeta?.provider).toBe("openrouter");
    expect(result.meta.agentMeta?.model).toBe("openai/gpt-5.4");
    expect(result.meta.executionTrace?.winnerProvider).toBe("openrouter");
    expect(result.meta.executionTrace?.winnerModel).toBe("openai/gpt-5.4");
  });

  // ─── T5-F1（codex P2・merge 前置条件）生产接线贯通（run 侧）─────────────────
  // 六形态矩阵（attempt.model-diagnostic-events.hook-scope.test.ts）手工注入 resolver，
  // 绕过 run bootstrap→attempt params 透传面；本组用例走生产调用面钉住 run.ts 侧接线：
  // ensure WithRegistry 返回真注册表 → run.ts:648-650 经共享 factory
  // createHookRunnerWithGlobalOptions 自建 scoped runner → :1671 透传 attempt params。
  // RED 依赖：删除 run.ts 的 factory 自建或 params 透传任一处，本组即红。
  // （attempt.ts:2899-2904 的 resolver 装配接线需真实执行 runEmbeddedAttempt 才能钉住，
  // 见 task-5-fix-report.md 的 BLOCKED 候选拆法。）
  it("用 run 自身注册表经共享 factory 自建 scoped runner 并透传 attempt（handler 真实可 fire）", async () => {
    const ended = vi.fn();
    const { registry } = createHookRunnerWithRegistry([
      { hookName: "model_call_ended", handler: ended },
    ]);
    mockedEnsureRuntimePluginsLoadedWithRegistry.mockReturnValue(registry);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1"],
      }),
    );

    await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-scoped-hook-wiring",
    });

    const scoped = firstAttemptInput().scopedHookRunner as HookRunner | null | undefined;
    // 透传面：必须是真 HookRunner（非 null/undefined）且注册表钩面在场。
    expect(scoped).toBeTruthy();
    expect(typeof scoped?.runModelCallEnded).toBe("function");
    expect(scoped?.hasHooks("model_call_ended")).toBe(true);
    // 功能级断言：runner 确由本次 ensure 返回的注册表构建——handler 真实 fire
    // （形状匹配不足以证明 factory 消费了 run 自身注册表）。
    await scoped?.runModelCallEnded(
      { runId: "run-scoped-hook-wiring", callId: "call-wiring" } as never,
      { runId: "run-scoped-hook-wiring" } as never,
    );
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("注册表不可得（plugins 禁用）时透传显式 null——全局有同名钩也不借（F3 空 scope 标记）", async () => {
    // 全局 sanity：全局 runner 带同名钩（若 run 侧误把 undefined 透传，attempt 按
    // F3 判「未供给」→ fallback 全局 → 借到该钩；显式 null 则不 fire 不 fallback）。
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "model_call_ended",
    );
    expect(mockedGlobalHookRunner.hasHooks("model_call_ended")).toBe(true);
    mockedEnsureRuntimePluginsLoadedWithRegistry.mockReturnValue(undefined);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1"],
      }),
    );

    await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-empty-scope-wiring",
    });

    const attemptInput = firstAttemptInput();
    // 严格 null（非 undefined）＝F3 显式空 scope 标记；「resolver null → 不 fire
    // 不借全局」的 dispatch 语义由 hook-scope F3 用例钉住（attempt 边界之下）。
    expect(attemptInput.scopedHookRunner).toBeNull();
    expect(attemptInput.scopedHookRunner).not.toBe(mockedGlobalHookRunner);
  });
});
