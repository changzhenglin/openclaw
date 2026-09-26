// A2UI card terminal tests cover fork-side latency governance T0a
// (Ruling-203①): a successful `agentos_a2ui_card` delivery should end the run
// so the model does not spend a final turn echoing card text the user already
// sees on screen (chat M=2→1). Gate fallback branches (reject honest card /
// annotate card) keep full-text receipts and must keep the current behavior
// (red line 3: gate/other tools zero change).
import type { Agent, AfterToolCallContext } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  installA2uiCardTerminalHook,
  shouldTerminateAfterA2uiCardDelivery,
} from "./a2ui-card-terminal.js";

// Production receipt text locked by cloud-ext a2ui-card-tool-gate.test.ts
// (T0c batch, Ruling-201): normal delivery returns this short acknowledgement.
const CARD_DELIVERED_TEXT =
  "Card delivered — the user already sees its text. Do NOT repeat or restate the card text in your reply; if there is nothing new to add, close with a very short acknowledgement (≤10 characters).";

describe("a2ui-card terminal delivery", () => {
  it("marks a delivered card (short delivery acknowledgement) as terminal", () => {
    expect(
      shouldTerminateAfterA2uiCardDelivery({
        context: createAfterToolCallContext({
          toolName: "agentos_a2ui_card",
          result: createCardDeliveredResult(),
        }),
      }),
    ).toBe(true);
  });

  it("terminates every card call of a same-message parallel batch", () => {
    // POI M=3 shape: one assistant message issues 2+ card calls in parallel
    // (c6 evidence pre02b2). agent-loop `shouldTerminateToolBatch` requires
    // EVERY finalized call to carry terminate, so the decision must be
    // per-call and uniform across the batch.
    const batchArgs = [
      { text: "Place A card", poi_ref: "poi-a" },
      { text: "Place B card", poi_ref: "poi-b" },
    ];
    for (const args of batchArgs) {
      expect(
        shouldTerminateAfterA2uiCardDelivery({
          context: createAfterToolCallContext({
            toolName: "agentos_a2ui_card",
            args,
            result: createCardDeliveredResult(),
          }),
        }),
      ).toBe(true);
    }
  });

  it("does not terminate gate fallback branches (reject honest card / annotate card)", () => {
    // Gate branches return full-text receipts (fallback semantics locked by
    // cloud-ext a2ui-card-tool-gate.test.ts), not the short delivery
    // acknowledgement: the model keeps its final turn (annotate expects a
    // possible follow-up call with a real ref).
    expect(
      shouldTerminateAfterA2uiCardDelivery({
        context: createAfterToolCallContext({
          toolName: "agentos_a2ui_card",
          result: createFullTextResult(
            "I can't verify live weather numbers right now, so here's what I can say honestly.",
          ),
        }),
      }),
    ).toBe(false);
    expect(
      shouldTerminateAfterA2uiCardDelivery({
        context: createAfterToolCallContext({
          toolName: "agentos_a2ui_card",
          result: createFullTextResult(
            "Note: these numbers could not be verified against a live source. 今天大概 25 度左右。",
          ),
        }),
      }),
    ).toBe(false);
  });

  it("does not terminate failed card deliveries", () => {
    expect(
      shouldTerminateAfterA2uiCardDelivery({
        context: createAfterToolCallContext({
          toolName: "agentos_a2ui_card",
          isError: true,
          result: createCardDeliveredResult(),
        }),
      }),
    ).toBe(false);
    expect(
      shouldTerminateAfterA2uiCardDelivery({
        context: createAfterToolCallContext({
          toolName: "agentos_a2ui_card",
          result: createCardDeliveredResult(),
        }),
        hookResult: { isError: true },
      }),
    ).toBe(false);
    expect(
      shouldTerminateAfterA2uiCardDelivery({
        context: createAfterToolCallContext({
          toolName: "agentos_a2ui_card",
          result: createErrorStatusResult(),
        }),
      }),
    ).toBe(false);
  });

  it("leaves other tools untouched (generic zero-regression)", () => {
    // Red line 3: any non-card tool must never receive a terminate hint, even
    // when its result looks like a delivered card receipt.
    for (const toolName of ["message", "agentos_poi_query", "weather", "sessions_send"]) {
      expect(
        shouldTerminateAfterA2uiCardDelivery({
          context: createAfterToolCallContext({
            toolName,
            result: createCardDeliveredResult(),
          }),
        }),
      ).toBe(false);
    }
  });

  it("preserves existing after-tool-call output while adding the terminal hint", async () => {
    const previousAfterToolCall = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "rewritten" }],
      details: { rewritten: true },
    }));
    const agent = { afterToolCall: previousAfterToolCall } as unknown as Agent;
    installA2uiCardTerminalHook({ agent });

    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "agentos_a2ui_card",
          result: createCardDeliveredResult(),
        }),
      ),
    ).resolves.toEqual({
      content: [{ type: "text", text: "rewritten" }],
      details: { rewritten: true },
      terminate: true,
    });
    expect(previousAfterToolCall).toHaveBeenCalledTimes(1);
  });

  it("passes non-card tool results through the wrapper unchanged", async () => {
    const previousAfterToolCall = vi.fn(async () => ({ details: { untouched: true } }));
    const agent = { afterToolCall: previousAfterToolCall } as unknown as Agent;
    installA2uiCardTerminalHook({ agent });

    await expect(
      agent.afterToolCall?.(createAfterToolCallContext({ toolName: "message" })),
    ).resolves.toEqual({ details: { untouched: true } });
    expect(previousAfterToolCall).toHaveBeenCalledTimes(1);
  });

  it("terminates without a previous hook installed", async () => {
    const agent = {} as unknown as Agent;
    installA2uiCardTerminalHook({ agent });

    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "agentos_a2ui_card",
          result: createCardDeliveredResult(),
        }),
      ),
    ).resolves.toEqual({ terminate: true });
  });
});

function createAfterToolCallContext(params: {
  toolName: string;
  args?: Record<string, unknown>;
  isError?: boolean;
  result?: AfterToolCallContext["result"];
}): AfterToolCallContext {
  const args = params.args ?? { text: "card body" };
  return {
    assistantMessage: createToolCallAssistant(params.toolName, args),
    toolCall: {
      type: "toolCall",
      id: "call_card",
      name: params.toolName,
      arguments: args,
    },
    args,
    result: params.result ?? createCardDeliveredResult(),
    isError: params.isError ?? false,
    context: {
      systemPrompt: "",
      messages: [],
      tools: [],
    },
  };
}

function createCardDeliveredResult(): AfterToolCallContext["result"] {
  return {
    content: [{ type: "text", text: CARD_DELIVERED_TEXT }],
    details: {
      status: "ok",
      messages: [{ type: "surface", surface: { components: [] } }],
    },
  };
}

function createFullTextResult(text: string): AfterToolCallContext["result"] {
  return {
    content: [{ type: "text", text }],
    details: {
      status: "ok",
      messages: [{ type: "surface", surface: { components: [] } }],
    },
  };
}

function createErrorStatusResult(): AfterToolCallContext["result"] {
  return {
    content: [{ type: "text", text: "tool execution failed" }],
    details: { status: "error" },
  };
}

function createToolCallAssistant(
  toolName: string,
  args: Record<string, unknown>,
): AfterToolCallContext["assistantMessage"] {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call_card",
        name: toolName,
        arguments: args,
      },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
}
