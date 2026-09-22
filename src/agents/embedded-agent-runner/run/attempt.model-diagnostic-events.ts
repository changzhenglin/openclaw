/**
 * Emits diagnostic model-call events around embedded-agent stream functions.
 */
import { fireAndForgetBoundedHook } from "../../../hooks/fire-and-forget.js";
import {
  diagnosticErrorCategory,
  diagnosticErrorFailureKind,
  diagnosticProviderRequestIdHash,
} from "../../../infra/diagnostic-error-metadata.js";
import {
  areDiagnosticsEnabledForProcess,
  emitTrustedDiagnosticEvent,
  type DiagnosticEventInput,
  type DiagnosticModelCallContent,
  type DiagnosticMemoryUsage,
  emitTrustedDiagnosticEventWithPrivateData,
} from "../../../infra/diagnostic-events.js";
import {
  cloneDiagnosticContentValue,
  resolveDiagnosticModelContentCapturePolicy,
  type DiagnosticModelContentCapturePolicy,
} from "../../../infra/diagnostic-llm-content.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  formatDiagnosticTraceparent,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { markDiagnosticRunProgress } from "../../../logging/diagnostic-run-activity.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type {
  PluginHookAgentContext,
  PluginHookContextWindowSource,
  PluginHookModelCallEndedEvent,
  PluginHookModelCallStartedEvent,
} from "../../../plugins/hook-types.js";
import type { HookRunner } from "../../../plugins/hooks.js";
import type { StreamFn } from "../../runtime/index.js";
import type { EmbeddedAgentExecutionPhase } from "../execution-phase.js";
import { log } from "../logger.js";
import type { EmbeddedRunContextWindowInfo } from "./types.js";

export { diagnosticErrorCategory };

type ModelCallDiagnosticContext = {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  model: string;
  api?: string;
  transport?: string;
  contextTokenBudget?: number;
  contextWindowSource?: PluginHookContextWindowSource;
  contextWindowReferenceTokens?: number;
  trace: DiagnosticTraceContext;
  contentCapture?: DiagnosticModelContentCapturePolicy;
  nextCallId: () => string;
  onStarted?: () => void;
  /**
   * F3 双语义（Ruling-187 丙案）：run 自身钩面解析器。
   * - undefined → dispatch fallback getGlobalHookRunner()（既有调用面兼容，
   *   沿 embedded-agent-subscribe.handlers.tools.ts `ctx.hookRunner ?? global` 先例形态）；
   * - 提供且返回 runner → 用该 runner（免疫第三方 scoped 激活对全局单例的 last-wins 覆盖）；
   * - 提供且返回 null → 不 fire 不 fallback（显式空 scope，不借全局钩）。
   */
  resolveHookRunner?: () => HookRunner | null;
};

/**
 * T5 乙案（Ruling-5・codex P2 merge 前置条件收尾）：attempt.ts wrap 位点的
 * ModelCallDiagnosticContext 构造整体抽出为导出纯函数——resolveHookRunner 装配
 * 分支（Ruling-187 丙案 F3 双语义）随迁至此成为可单测面；attempt.ts 改单行
 * 调用＝纯重构零行为变化（nextCallId 计数器 per-call 新建，与原 attempt 局部
 * diagnosticModelCallSeq 语义等价：每次 attempt 构造 ctx 时从 0 起）。
 *
 * resolveHookRunner 装配语义（原 attempt.ts:2899-2904 注释随迁）：仅当调用方
 * （run.ts）显式供给 scopedHookRunner 时才装 resolver——undefined 保持既有
 * fallback 全局语义（F3 兼容面）；供给则用 run 自身注册表 runner（覆盖免疫），
 * null＝显式空 scope（不 fire 不 fallback）。
 */
export function buildModelCallDiagnosticContext(params: {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  modelId: string;
  modelApi?: string;
  transport?: string;
  contextWindowInfo?: EmbeddedRunContextWindowInfo;
  config?: unknown;
  trace: DiagnosticTraceContext;
  scopedHookRunner?: HookRunner | null;
  onExecutionPhase?: (info: {
    phase: EmbeddedAgentExecutionPhase;
    provider?: string;
    model?: string;
    firstModelCallStarted?: boolean;
  }) => void;
}): ModelCallDiagnosticContext {
  let modelCallSeq = 0;
  return {
    runId: params.runId,
    ...(params.sessionKey && { sessionKey: params.sessionKey }),
    ...(params.sessionId && { sessionId: params.sessionId }),
    provider: params.provider,
    model: params.modelId,
    api: params.modelApi,
    transport: params.transport,
    ...(params.contextWindowInfo?.tokens
      ? { contextTokenBudget: params.contextWindowInfo.tokens }
      : {}),
    ...(params.contextWindowInfo?.source
      ? { contextWindowSource: params.contextWindowInfo.source }
      : {}),
    ...(params.contextWindowInfo?.referenceTokens
      ? { contextWindowReferenceTokens: params.contextWindowInfo.referenceTokens }
      : {}),
    trace: params.trace,
    contentCapture: resolveDiagnosticModelContentCapturePolicy(params.config),
    nextCallId: () => `${params.runId}:model:${(modelCallSeq += 1)}`,
    ...(params.scopedHookRunner !== undefined
      ? { resolveHookRunner: () => params.scopedHookRunner ?? null }
      : {}),
    onStarted: () => {
      params.onExecutionPhase?.({
        phase: "model_call_started",
        provider: params.provider,
        model: params.modelId,
        firstModelCallStarted: true,
      });
    },
  };
}

type ModelCallEventBase = Omit<
  Extract<DiagnosticEventInput, { type: "model.call.started" }>,
  "type"
>;
type ModelCallErrorFields = Pick<
  Extract<DiagnosticEventInput, { type: "model.call.error" }>,
  "errorCategory" | "failureKind" | "memory" | "upstreamRequestIdHash"
>;
type ModelCallEndedHookFields = Pick<
  PluginHookModelCallEndedEvent,
  | "durationMs"
  | "outcome"
  | "errorCategory"
  | "requestPayloadBytes"
  | "responseStreamBytes"
  | "timeToFirstByteMs"
  | "failureKind"
  | "upstreamRequestIdHash"
>;
type ModelCallSizeTimingFields = Pick<
  Extract<DiagnosticEventInput, { type: "model.call.completed" }>,
  "requestPayloadBytes" | "responseStreamBytes" | "timeToFirstByteMs"
>;
type ModelCallObservationState = {
  requestPayloadBytes?: number;
  responseStreamBytes: number;
  timeToFirstByteMs?: number;
  modelContent?: DiagnosticModelCallContent;
  outputMessages?: unknown[];
  contentCapture?: DiagnosticModelContentCapturePolicy;
  lastStreamProgressAt?: number;
};

const MODEL_CALL_STREAM_PROGRESS_INTERVAL_MS = 30_000;
const MODEL_CALL_STREAM_PROGRESS_REASON = "model_call:stream_progress";
const MODEL_CALL_STREAM_RETURN_TIMEOUT_MS = 1000;
const TRACEPARENT_HEADER_NAME = "traceparent";
type ModelCallStreamOptions = Parameters<StreamFn>[2];

function utf8JsonByteLength(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

function assignRequestPayloadBytes(state: ModelCallObservationState, payload: unknown): void {
  const bytes = utf8JsonByteLength(payload);
  if (bytes !== undefined) {
    state.requestPayloadBytes = bytes;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function utf8StringByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function streamDeltaByteLength(chunk: Record<string, unknown>): number | undefined {
  const type = chunk.type;
  if (
    (type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta") &&
    typeof chunk.delta === "string"
  ) {
    return utf8StringByteLength(chunk.delta);
  }
  return undefined;
}

function responseStreamChunkByteLengthUnchecked(chunk: unknown): number | undefined {
  if (!isRecord(chunk)) {
    return utf8JsonByteLength(chunk);
  }
  const deltaBytes = streamDeltaByteLength(chunk);
  if (deltaBytes !== undefined) {
    return deltaBytes;
  }
  if (!("partial" in chunk)) {
    return utf8JsonByteLength(chunk);
  }
  // Plain stream deltas can carry an accumulated partial snapshot. Byte metrics
  // count the new stream payload, not the answer-so-far replay.
  const { partial: _partial, ...snapshotlessChunk } = chunk;
  return utf8JsonByteLength(snapshotlessChunk);
}

function responseStreamChunkByteLength(chunk: unknown): number | undefined {
  try {
    return responseStreamChunkByteLengthUnchecked(chunk);
  } catch {
    return undefined;
  }
}

function streamContextModelContentFields(
  policy: DiagnosticModelContentCapturePolicy | undefined,
  streamContext: unknown,
): DiagnosticModelCallContent | undefined {
  if (!policy?.anyModelContent || !isRecord(streamContext)) {
    return undefined;
  }
  const content = {
    ...(policy.inputMessages && Array.isArray(streamContext.messages)
      ? { inputMessages: cloneDiagnosticContentValue(streamContext.messages) }
      : {}),
    ...(policy.systemPrompt && typeof streamContext.systemPrompt === "string"
      ? { systemPrompt: streamContext.systemPrompt }
      : {}),
    ...(policy.toolDefinitions && Array.isArray(streamContext.tools)
      ? { toolDefinitions: cloneDiagnosticContentValue(streamContext.tools) }
      : {}),
  };
  return Object.keys(content).length > 0 ? content : undefined;
}

function observeOutputMessageContent(state: ModelCallObservationState, chunk: unknown): void {
  if (!state.contentCapture?.outputMessages || !isRecord(chunk)) {
    return;
  }
  const message =
    chunk.type === "done" ? chunk.message : chunk.type === "error" ? chunk.error : undefined;
  if (message !== undefined) {
    state.outputMessages = [cloneDiagnosticContentValue(message)];
  }
}

function observeResponseChunk(
  state: ModelCallObservationState,
  startedAt: number,
  chunk: unknown,
): void {
  state.timeToFirstByteMs ??= Math.max(0, Date.now() - startedAt);
  observeOutputMessageContent(state, chunk);
  const bytes = responseStreamChunkByteLength(chunk);
  if (bytes !== undefined) {
    state.responseStreamBytes += bytes;
  }
}

function maybeEmitModelCallStreamProgress(
  eventBase: ModelCallEventBase,
  state: ModelCallObservationState,
): void {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  const now = Date.now();
  const progressFields = {
    runId: eventBase.runId,
    ...(eventBase.sessionKey ? { sessionKey: eventBase.sessionKey } : {}),
    ...(eventBase.sessionId ? { sessionId: eventBase.sessionId } : {}),
    reason: MODEL_CALL_STREAM_PROGRESS_REASON,
  };
  markDiagnosticRunProgress(progressFields);
  if (
    state.lastStreamProgressAt !== undefined &&
    now - state.lastStreamProgressAt < MODEL_CALL_STREAM_PROGRESS_INTERVAL_MS
  ) {
    return;
  }
  state.lastStreamProgressAt = now;
  // Streaming providers, local or remote, are expected to produce chunks or
  // heartbeat-style progress. The in-memory freshness clock is refreshed for
  // each chunk, while diagnostic events are throttled so token streams do not
  // spam observers; silent/non-streaming calls remain recoverable after the
  // configured stuck-session timeout.
  emitTrustedDiagnosticEvent({
    type: "run.progress",
    ...progressFields,
  });
}

function modelCallSizeTimingFields(state: ModelCallObservationState): ModelCallSizeTimingFields {
  return {
    ...(state.requestPayloadBytes !== undefined
      ? { requestPayloadBytes: state.requestPayloadBytes }
      : {}),
    ...(state.responseStreamBytes > 0 ? { responseStreamBytes: state.responseStreamBytes } : {}),
    ...(state.timeToFirstByteMs !== undefined
      ? { timeToFirstByteMs: state.timeToFirstByteMs }
      : {}),
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return false;
  }
}

function asyncIteratorFactory(value: unknown): (() => AsyncIterator<unknown>) | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  try {
    const asyncIterator = (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
    if (typeof asyncIterator !== "function") {
      return undefined;
    }
    return () => asyncIterator.call(value) as AsyncIterator<unknown>;
  } catch {
    return undefined;
  }
}

function baseModelCallEvent(
  ctx: ModelCallDiagnosticContext,
  callId: string,
  trace: DiagnosticTraceContext,
): ModelCallEventBase {
  return {
    runId: ctx.runId,
    callId,
    ...(ctx.sessionKey && { sessionKey: ctx.sessionKey }),
    ...(ctx.sessionId && { sessionId: ctx.sessionId }),
    provider: ctx.provider,
    model: ctx.model,
    ...(ctx.api && { api: ctx.api }),
    ...(ctx.transport && { transport: ctx.transport }),
    ...(ctx.contextTokenBudget ? { contextTokenBudget: ctx.contextTokenBudget } : {}),
    ...(ctx.contextWindowSource ? { contextWindowSource: ctx.contextWindowSource } : {}),
    ...(ctx.contextWindowReferenceTokens
      ? { contextWindowReferenceTokens: ctx.contextWindowReferenceTokens }
      : {}),
    trace,
  };
}

function modelContentPrivateData(modelContent: DiagnosticModelCallContent | undefined) {
  return modelContent ? { modelContent } : undefined;
}

function modelCallCompletedContent(state: ModelCallObservationState) {
  if (!state.modelContent && !state.outputMessages) {
    return undefined;
  }
  return {
    ...state.modelContent,
    ...(state.outputMessages ? { outputMessages: state.outputMessages } : {}),
  };
}

function modelCallErrorFields(err: unknown): ModelCallErrorFields {
  const upstreamRequestIdHash = diagnosticProviderRequestIdHash(err);
  const failureKind = diagnosticErrorFailureKind(err);
  return {
    errorCategory: diagnosticErrorCategory(err),
    ...(failureKind ? { failureKind, memory: processMemoryUsageSnapshot() } : {}),
    ...(upstreamRequestIdHash ? { upstreamRequestIdHash } : {}),
  };
}

function processMemoryUsageSnapshot(): DiagnosticMemoryUsage | undefined {
  try {
    const memory = process.memoryUsage();
    return {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    };
  } catch {
    return undefined;
  }
}

function modelCallHookEventBase(eventBase: ModelCallEventBase): PluginHookModelCallStartedEvent {
  return {
    runId: eventBase.runId,
    callId: eventBase.callId,
    ...(eventBase.sessionKey ? { sessionKey: eventBase.sessionKey } : {}),
    ...(eventBase.sessionId ? { sessionId: eventBase.sessionId } : {}),
    provider: eventBase.provider,
    model: eventBase.model,
    ...(eventBase.api ? { api: eventBase.api } : {}),
    ...(eventBase.transport ? { transport: eventBase.transport } : {}),
    ...(eventBase.contextTokenBudget ? { contextTokenBudget: eventBase.contextTokenBudget } : {}),
    ...(eventBase.contextWindowSource
      ? { contextWindowSource: eventBase.contextWindowSource }
      : {}),
    ...(eventBase.contextWindowReferenceTokens
      ? { contextWindowReferenceTokens: eventBase.contextWindowReferenceTokens }
      : {}),
  };
}

function modelCallHookContext(eventBase: ModelCallEventBase): PluginHookAgentContext {
  return Object.freeze({
    runId: eventBase.runId,
    trace: eventBase.trace,
    ...(eventBase.sessionKey ? { sessionKey: eventBase.sessionKey } : {}),
    ...(eventBase.sessionId ? { sessionId: eventBase.sessionId } : {}),
    modelProviderId: eventBase.provider,
    modelId: eventBase.model,
    ...(eventBase.contextTokenBudget ? { contextTokenBudget: eventBase.contextTokenBudget } : {}),
    ...(eventBase.contextWindowSource
      ? { contextWindowSource: eventBase.contextWindowSource }
      : {}),
    ...(eventBase.contextWindowReferenceTokens
      ? { contextWindowReferenceTokens: eventBase.contextWindowReferenceTokens }
      : {}),
  }) as PluginHookAgentContext;
}

/**
 * F3 双语义 + 3A② 缓存（Ruling-187 丙案）：
 * ctx 提供 resolver 时，其结果在 wrap 生命周期（= run/attempt）内只解析一次并缓存，
 * 每次 model call 不重复解析；未提供时保持既有语义——每次 dispatch 读全局单例。
 */
function createDispatchHookRunnerResolver(
  ctx: ModelCallDiagnosticContext,
): () => HookRunner | null {
  const resolve = ctx.resolveHookRunner;
  if (!resolve) {
    return () => getGlobalHookRunner();
  }
  let resolved = false;
  let cached: HookRunner | null = null;
  return () => {
    if (!resolved) {
      resolved = true;
      cached = resolve() ?? null;
    }
    return cached;
  };
}

/**
 * A0 观测面（Ruling-187）：此路径原为静默 return 零日志——生产 23 轮 hook 丢失
 * 无任何痕迹（gateway-b3-debug.log 实证）。现以 debug 记录跳过原因：
 * no-hook-runner = resolver 显式空 scope 或全局未初始化；no-hooks-registered = 注册表无该 hook。
 */
function logHookDispatchSkipped(
  hookName: "model_call_started" | "model_call_ended",
  hookRunner: HookRunner | null,
  eventBase: ModelCallEventBase,
): void {
  log.debug(
    `plugin hook dispatch skipped: hook=${hookName} reason=${
      hookRunner ? "no-hooks-registered" : "no-hook-runner"
    } runId=${eventBase.runId} callId=${eventBase.callId}`,
  );
}

function dispatchModelCallStartedHook(
  eventBase: ModelCallEventBase,
  resolveHookRunner: () => HookRunner | null,
): void {
  const hookRunner = resolveHookRunner();
  if (!hookRunner?.hasHooks("model_call_started")) {
    logHookDispatchSkipped("model_call_started", hookRunner, eventBase);
    return;
  }
  const event = Object.freeze(modelCallHookEventBase(eventBase)) as PluginHookModelCallStartedEvent;
  const hookCtx = modelCallHookContext(eventBase);
  fireAndForgetBoundedHook(
    () => hookRunner.runModelCallStarted(event, hookCtx),
    "model_call_started plugin hook failed",
  );
}

function dispatchModelCallEndedHook(
  eventBase: ModelCallEventBase,
  fields: ModelCallEndedHookFields,
  resolveHookRunner: () => HookRunner | null,
): void {
  const hookRunner = resolveHookRunner();
  if (!hookRunner?.hasHooks("model_call_ended")) {
    logHookDispatchSkipped("model_call_ended", hookRunner, eventBase);
    return;
  }
  const event = Object.freeze({
    ...modelCallHookEventBase(eventBase),
    ...fields,
  }) as PluginHookModelCallEndedEvent;
  const hookCtx = modelCallHookContext(eventBase);
  fireAndForgetBoundedHook(
    () => hookRunner.runModelCallEnded(event, hookCtx),
    "model_call_ended plugin hook failed",
  );
}

function emitModelCallStarted(
  eventBase: ModelCallEventBase,
  modelContent: DiagnosticModelCallContent | undefined,
  resolveHookRunner: () => HookRunner | null,
): void {
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "model.call.started",
      ...eventBase,
    },
    modelContentPrivateData(modelContent),
  );
  dispatchModelCallStartedHook(eventBase, resolveHookRunner);
}

function emitModelCallCompleted(
  eventBase: ModelCallEventBase,
  startedAt: number,
  state: ModelCallObservationState,
  resolveHookRunner: () => HookRunner | null,
): void {
  const durationMs = Date.now() - startedAt;
  const sizeTimingFields = modelCallSizeTimingFields(state);
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "model.call.completed",
      ...eventBase,
      durationMs,
      ...sizeTimingFields,
    },
    modelContentPrivateData(modelCallCompletedContent(state)),
  );
  dispatchModelCallEndedHook(
    eventBase,
    {
      durationMs,
      outcome: "completed",
      ...sizeTimingFields,
    },
    resolveHookRunner,
  );
}

function emitModelCallError(
  eventBase: ModelCallEventBase,
  startedAt: number,
  state: ModelCallObservationState,
  fields: ModelCallErrorFields,
  resolveHookRunner: () => HookRunner | null,
): void {
  const durationMs = Date.now() - startedAt;
  const sizeTimingFields = modelCallSizeTimingFields(state);
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "model.call.error",
      ...eventBase,
      durationMs,
      ...sizeTimingFields,
      ...fields,
    },
    modelContentPrivateData(modelCallCompletedContent(state)),
  );
  dispatchModelCallEndedHook(
    eventBase,
    {
      durationMs,
      outcome: "error",
      ...sizeTimingFields,
      ...fields,
    },
    resolveHookRunner,
  );
}

function withDiagnosticTraceparentHeader(
  options: ModelCallStreamOptions,
  trace: DiagnosticTraceContext,
  state: ModelCallObservationState,
): ModelCallStreamOptions {
  const traceparent = formatDiagnosticTraceparent(trace);
  const originalOnPayload = options?.onPayload;
  const onPayload: NonNullable<ModelCallStreamOptions>["onPayload"] = (payload, model) => {
    if (!originalOnPayload) {
      assignRequestPayloadBytes(state, payload);
      return undefined;
    }
    const result = originalOnPayload(payload, model);
    if (isPromiseLike(result)) {
      return result.then((replacement) => {
        assignRequestPayloadBytes(state, replacement ?? payload);
        return replacement;
      });
    }
    assignRequestPayloadBytes(state, result ?? payload);
    return result;
  };

  if (!traceparent) {
    return {
      ...options,
      onPayload,
    };
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(options?.headers ?? {})) {
    if (key.toLowerCase() === TRACEPARENT_HEADER_NAME) {
      continue;
    }
    headers[key] = value;
  }
  headers[TRACEPARENT_HEADER_NAME] = traceparent;
  return {
    ...options,
    headers,
    onPayload,
  };
}

async function safeReturnIterator(iterator: AsyncIterator<unknown>): Promise<void> {
  let returnResult: unknown;
  try {
    returnResult = iterator.return?.();
  } catch {
    return;
  }
  if (!returnResult) {
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Early consumer return should not hang diagnostic completion forever; give
    // provider cleanup a short chance, then emit completion for the observed call.
    await Promise.race([
      Promise.resolve(returnResult).catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, MODEL_CALL_STREAM_RETURN_TIMEOUT_MS);
        const unref =
          typeof timeout === "object" && timeout
            ? (timeout as { unref?: () => void }).unref
            : undefined;
        if (unref) {
          unref.call(timeout);
        }
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function* observeModelCallIterator<T>(
  iterator: AsyncIterator<T>,
  eventBase: ModelCallEventBase,
  startedAt: number,
  state: ModelCallObservationState,
  resolveHookRunner: () => HookRunner | null,
): AsyncIterable<T> {
  let terminalEmitted = false;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      observeResponseChunk(state, startedAt, next.value);
      maybeEmitModelCallStreamProgress(eventBase, state);
      yield next.value;
    }
    terminalEmitted = true;
    emitModelCallCompleted(eventBase, startedAt, state, resolveHookRunner);
  } catch (err) {
    terminalEmitted = true;
    emitModelCallError(eventBase, startedAt, state, modelCallErrorFields(err), resolveHookRunner);
    throw err;
  } finally {
    if (!terminalEmitted) {
      // A consumer can stop reading before the provider emits done/error. Close
      // the iterator best-effort and record the call as completed with observed bytes.
      await safeReturnIterator(iterator);
      emitModelCallCompleted(eventBase, startedAt, state, resolveHookRunner);
    }
  }
}

function observeModelCallStream<T extends AsyncIterable<unknown>>(
  stream: T,
  createIterator: () => AsyncIterator<unknown>,
  eventBase: ModelCallEventBase,
  startedAt: number,
  state: ModelCallObservationState,
  resolveHookRunner: () => HookRunner | null,
): T {
  const observedIterator = () =>
    observeModelCallIterator(createIterator(), eventBase, startedAt, state, resolveHookRunner)[
      Symbol.asyncIterator
    ]();
  let hasNonConfigurableIterator;
  try {
    hasNonConfigurableIterator =
      Object.getOwnPropertyDescriptor(stream, Symbol.asyncIterator)?.configurable === false;
  } catch {
    hasNonConfigurableIterator = true;
  }
  if (hasNonConfigurableIterator) {
    return {
      [Symbol.asyncIterator]: observedIterator,
    } as T;
  }
  return new Proxy(stream, {
    get(target, property, receiver) {
      if (property === Symbol.asyncIterator) {
        return observedIterator;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function observeModelCallResult(
  result: unknown,
  eventBase: ModelCallEventBase,
  startedAt: number,
  state: ModelCallObservationState,
  resolveHookRunner: () => HookRunner | null,
): unknown {
  const createIterator = asyncIteratorFactory(result);
  if (createIterator) {
    return observeModelCallStream(
      result as AsyncIterable<unknown>,
      createIterator,
      eventBase,
      startedAt,
      state,
      resolveHookRunner,
    );
  }
  emitModelCallCompleted(eventBase, startedAt, state, resolveHookRunner);
  return result;
}

/**
 * Wraps a model stream function with diagnostic model-call lifecycle events,
 * traceparent propagation, request/response byte accounting, optional captured
 * model content, progress heartbeats, and plugin hook dispatch.
 */
export function wrapStreamFnWithDiagnosticModelCallEvents(
  streamFn: StreamFn,
  ctx: ModelCallDiagnosticContext,
): StreamFn {
  // 丙案（Ruling-187）：hook dispatch 钩面在 wrap 时绑定一次（3A② run 内缓存），
  // 后续第三方 initializeGlobalHookRunner last-wins 覆盖不影响本 run 的 dispatch。
  const resolveHookRunner = createDispatchHookRunnerResolver(ctx);
  return ((model, streamContext, options) => {
    const callId = ctx.nextCallId();
    const trace = freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(ctx.trace));
    const eventBase = baseModelCallEvent(ctx, callId, trace);
    const modelContent = streamContextModelContentFields(ctx.contentCapture, streamContext);
    emitModelCallStarted(eventBase, modelContent, resolveHookRunner);
    ctx.onStarted?.();
    const startedAt = Date.now();
    const state: ModelCallObservationState = {
      responseStreamBytes: 0,
      modelContent,
      contentCapture: ctx.contentCapture,
    };
    const propagatedOptions = withDiagnosticTraceparentHeader(options, trace, state);

    try {
      const result = streamFn(model, streamContext, propagatedOptions);
      if (isPromiseLike(result)) {
        return result.then(
          (resolved) =>
            observeModelCallResult(resolved, eventBase, startedAt, state, resolveHookRunner),
          (err: unknown) => {
            emitModelCallError(
              eventBase,
              startedAt,
              state,
              modelCallErrorFields(err),
              resolveHookRunner,
            );
            throw err;
          },
        );
      }
      return observeModelCallResult(result, eventBase, startedAt, state, resolveHookRunner);
    } catch (err) {
      emitModelCallError(eventBase, startedAt, state, modelCallErrorFields(err), resolveHookRunner);
      throw err;
    }
  }) as StreamFn;
}
