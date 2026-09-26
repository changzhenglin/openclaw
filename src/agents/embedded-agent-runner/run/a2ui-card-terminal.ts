// T0a (Ruling-203①・latency governance): terminate the turn after a delivered
// a2ui card so the model does not spend a final turn echoing card text the user
// already sees on screen. Mirrors the message-tool-terminal pattern (wrap-style
// install, previous hook chain preserved). Gate fallback branches (reject
// honest card / annotate card) return full-text receipts instead of the short
// delivery acknowledgement and intentionally keep the current behavior
// (red line 3: gate/other tools zero change).
import { isToolResultError } from "../../embedded-agent-subscribe.tools.js";
import type { AfterToolCallContext, AfterToolCallResult, Agent } from "../../runtime/index.js";
import { normalizeToolName } from "../../tool-policy.js";

const A2UI_CARD_TOOL_NAME = "agentos_a2ui_card";
// Short delivery acknowledgement emitted by the cloud-ext card tool's normal
// branch (receipt text locked by a2ui-card-tool-gate.test.ts, T0c batch).
const CARD_DELIVERED_PREFIX = "Card delivered";

/**
 * Decides whether an `agentos_a2ui_card` tool call should end the turn:
 * the card is already on screen, so a final echo turn adds zero information.
 */
export function shouldTerminateAfterA2uiCardDelivery(params: {
  context: AfterToolCallContext;
  hookResult?: AfterToolCallResult;
}): boolean {
  if (normalizeToolName(params.context.toolCall.name) !== A2UI_CARD_TOOL_NAME) {
    return false;
  }
  const isError = params.hookResult?.isError ?? params.context.isError;
  if (isError || isToolResultError(params.context.result)) {
    return false;
  }
  // Normal delivery receipts are a single text part (cloud-ext tool shape,
  // verified in recon report §一); gate branches carry full-text receipts and
  // never start with the acknowledgement prefix.
  const content = params.context.result?.content;
  return (
    Array.isArray(content) &&
    content.some(
      (part) =>
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.startsWith(CARD_DELIVERED_PREFIX),
    )
  );
}

/** Installs an after-tool hook that terminates the turn after a qualifying card delivery. */
export function installA2uiCardTerminalHook(params: { agent: Agent }): void {
  const previousAfterToolCall = params.agent.afterToolCall?.bind(params.agent);
  params.agent.afterToolCall = async (context, signal) => {
    const hookResult = await previousAfterToolCall?.(context, signal);
    if (shouldTerminateAfterA2uiCardDelivery({ context, hookResult })) {
      return { ...hookResult, terminate: true };
    }
    return hookResult;
  };
}
