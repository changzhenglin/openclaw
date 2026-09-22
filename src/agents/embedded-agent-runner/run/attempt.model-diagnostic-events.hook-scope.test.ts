// F4 断言面迁移（Ruling-187 A 臂・RED 骨架・plan-eng-review codex F4 remedy）：
// hook-firing gap 的 RED→GREEN 证据链必须与修复面同层——A 臂（丙案）修的是
// dispatch 消费路径（run 自身注册表），不触碰全局 runner 覆盖行为本身；
// 故目标行为断言落本文件（dispatch 可观察行为＝hook handler 被调用），
// 全局 runner 覆盖断言（loader.hook-runner-scoped-activation.test.ts）降为
// 机制记录面（document-the-bug・丙案落地后按 SDD 首步裁量改造或删除）。
//
// 生产对照面（gateway-b3-debug.log 2026-09-22）：
// - 03:46:44 scoped load → 03:47:11 fire（覆盖后带钩注册表恰好在场）
// - 03:54+ 23 轮 inject 静默（后续覆盖换成无钩注册表→全局单例失钩→dispatch 静默 return）
// 丙案目标：run 在自身 bootstrap 捕获钩面后，任何第三方 last-wins 覆盖不影响该 run 的 dispatch。
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import {
  createHookRunnerWithGlobalOptions,
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../plugins/hook-runner-global.js";
import { createHookRunnerWithRegistry } from "../../../plugins/hooks.test-helpers.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";

// A0 静默路径 debug log 断言用 logger spy（../logger.js 仅被本 graph 的
// attempt.model-diagnostic-events.js 引用，plugins/hooks/infra 侧无涉）。
const mocks = vi.hoisted(() => ({
  logDebug: vi.fn(),
}));

vi.mock("../logger.js", () => {
  const noop = () => {};
  return {
    log: {
      subsystem: "agent/embedded",
      isEnabled: () => false,
      trace: noop,
      debug: mocks.logDebug,
      info: noop,
      warn: noop,
      error: noop,
      fatal: noop,
      raw: noop,
      child: noop,
    },
  };
});

beforeEach(() => {
  mocks.logDebug.mockReset();
});

afterEach(() => {
  resetGlobalHookRunner();
});

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    // no-op drain
  }
}

async function settleFireAndForget(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function makeStreamFn(): StreamFn {
  return (() => {
    async function* stream() {
      yield { type: "text", text: "hello" };
    }
    return stream();
  }) as unknown as StreamFn;
}

describe("model-call hook dispatch across third-party runner clobber (hook-firing gap)", () => {
  it("RED(丙案目标): run 捕获钩面后第三方 last-wins 覆盖全局 runner，不影响该 run 的 model_call_ended dispatch", async () => {
    const ended = vi.fn();
    const { registry } = createHookRunnerWithRegistry([
      { hookName: "model_call_ended", handler: ended },
    ]);
    initializeGlobalHookRunner(registry);

    // run bootstrap（丙案目标面）：捕获此刻的 runner 作为 run 自身钩面。
    // resolveHookRunner 为丙案将新增的 ModelCallDiagnosticContext 可选字段——
    // 现状实现无此字段（transpile 忽略・运行时走 fallback 全局单例）＝RED 来源；
    // 丙案落地后 dispatch 优先用本 resolver → 覆盖免疫 → GREEN。
    const capturedRunner = getGlobalHookRunner();
    expect(capturedRunner?.hasHooks("model_call_ended")).toBe(true); // sanity: 捕获时带钩

    async function* stream() {
      yield { type: "text", text: "hello" };
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-scope",
        provider: "openai",
        model: "gpt-x",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-scope",
        resolveHookRunner: () => capturedRunner,
      } as never,
    );

    // 第三方 scoped 激活覆盖（03:54 静默形态等价）：全局 runner 换成无钩注册表
    const { registry: hooklessRegistry } = createHookRunnerWithRegistry([]);
    initializeGlobalHookRunner(hooklessRegistry);
    expect(getGlobalHookRunner()?.hasHooks("model_call_ended")).toBe(false); // 覆盖已发生

    await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    // 丙案目标：run 用自身捕获的钩面 dispatch → handler 恰好一次。
    // 现状：dispatch 读全局单例（覆盖后无钩）→ hasHooks=false → 静默 return → 0 次 = RED。
    expect(ended).toHaveBeenCalledTimes(1);
  });
});

describe("捕获点定案（(a) 全局 vs (b) run 自身注册表・暖 cache 不激活判据）", () => {
  it("定案=(b)：暖 cache 加载不激活全局单例时，(a) 捕获全局失钩而 (b) 用 run 自身注册表仍 fire", async () => {
    // 判据（standalone-runtime-registry-loader.ts:63-70）：暖 runtime 命中 cache
    // early-return——不 loadOpenClawPlugins、不 activatePluginRegistry，故全局单例
    // 不会刷新为本次 run 的注册表；此刻全局可能是他 run 覆盖后的无钩 runner。
    //
    // 构造：全局单例＝无钩注册表（模拟他 run last-wins 覆盖 / 暖 cache 未激活）；
    // 本次 run 自身注册表＝含 model_call_ended（(b) 路线经共享 factory 自建 runner）。
    const { registry: hooklessGlobal } = createHookRunnerWithRegistry([]);
    initializeGlobalHookRunner(hooklessGlobal);
    expect(getGlobalHookRunner()?.hasHooks("model_call_ended")).toBe(false); // 全局无钩

    const runScopedEnded = vi.fn();
    const { registry: runOwnRegistry } = createHookRunnerWithRegistry([
      { hookName: "model_call_ended", handler: runScopedEnded },
    ]);
    // (b) 路线：run 用自身注册表 + 共享 factory（与 initializeGlobalHookRunner 同源 options・3A①）
    const runScopedRunner = createHookRunnerWithGlobalOptions(runOwnRegistry);
    expect(runScopedRunner.hasHooks("model_call_ended")).toBe(true); // sanity: 自身注册表带钩

    // (a) 路线对照：ensure 后立即捕获全局引用 → 捕到的是无钩全局（错）。
    const resolverA = () => getGlobalHookRunner();
    const wrappedA = wrapStreamFnWithDiagnosticModelCallEvents(makeStreamFn(), {
      runId: "run-a",
      provider: "openai",
      model: "gpt-x",
      trace: createDiagnosticTraceContext(),
      nextCallId: () => "call-a",
      resolveHookRunner: resolverA,
    } as never);
    await drain(wrappedA({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    await settleFireAndForget();
    // (a) 定案否决证据：捕获全局 → 暖 cache 未激活 → 全局无钩 → 0 次（缺陷形态）。
    expect(runScopedEnded).toHaveBeenCalledTimes(0);

    // (b) 路线：resolver 返回 run 自身注册表 runner → 免疫全局无钩 → 恰好 1 次。
    const wrappedB = wrapStreamFnWithDiagnosticModelCallEvents(makeStreamFn(), {
      runId: "run-b",
      provider: "openai",
      model: "gpt-x",
      trace: createDiagnosticTraceContext(),
      nextCallId: () => "call-b",
      resolveHookRunner: () => runScopedRunner,
    } as never);
    await drain(wrappedB({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    await settleFireAndForget();
    expect(runScopedEnded).toHaveBeenCalledTimes(1); // (b) 定案采纳证据
  });
});

describe("dispatch resolver semantics (F3 双语义 + 3A② 缓存 + A0 观测面)", () => {
  function wrapWithResolver(resolveHookRunner?: () => unknown) {
    return wrapStreamFnWithDiagnosticModelCallEvents(makeStreamFn(), {
      runId: "run-resolver",
      provider: "openai",
      model: "gpt-x",
      trace: createDiagnosticTraceContext(),
      nextCallId: () => "call-resolver",
      ...(resolveHookRunner ? { resolveHookRunner } : {}),
    } as never);
  }

  it("resolver 命中路径 fire：全局单例为 null 时仍用 resolver 返回的 runner dispatch", async () => {
    // 全局单例不初始化（resetGlobalHookRunner 后为 null）——若 dispatch 仍走
    // 全局 fallback 则 0 次；resolver 命中则恰好 1 次。
    expect(getGlobalHookRunner()).toBeNull();
    const ended = vi.fn();
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "model_call_ended", handler: ended },
    ]);

    const wrapped = wrapWithResolver(() => runner);
    await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    await settleFireAndForget();

    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("F3 显式空 scope：resolver 返回 null 时不 fire 不 fallback（全局有钩也不借）", async () => {
    const globalEnded = vi.fn();
    const { registry: globalRegistry } = createHookRunnerWithRegistry([
      { hookName: "model_call_ended", handler: globalEnded },
    ]);
    initializeGlobalHookRunner(globalRegistry);
    expect(getGlobalHookRunner()?.hasHooks("model_call_ended")).toBe(true); // sanity: 全局确有钩

    const wrapped = wrapWithResolver(() => null);
    await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    await settleFireAndForget();

    expect(globalEnded).not.toHaveBeenCalled();
  });

  it("3A②：resolver 结果 run 内缓存一次——多次 model call 只解析一次", async () => {
    const ended = vi.fn();
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "model_call_ended", handler: ended },
    ]);
    const resolveHookRunner = vi.fn(() => runner);

    let callSeq = 0;
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(makeStreamFn(), {
      runId: "run-cache",
      provider: "openai",
      model: "gpt-x",
      trace: createDiagnosticTraceContext(),
      nextCallId: () => `call-cache:${(callSeq += 1)}`,
      resolveHookRunner,
    } as never);

    // 同一 wrap（= 同一 run/attempt）两次 model call
    await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    await settleFireAndForget();

    expect(ended).toHaveBeenCalledTimes(2); // 两次 call 均 fire
    expect(resolveHookRunner).toHaveBeenCalledTimes(1); // 解析只发生一次（缓存）
  });

  it("A0：静默路径（无钩可 dispatch）发出 debug log 记录跳过原因", async () => {
    // resolver → null（显式空 scope）：started/ended 两处 dispatch 均静默跳过，
    // 每处必须留 debug 痕迹（原实现零日志 = 观测盲区）。
    const wrapped = wrapWithResolver(() => null);
    await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    await settleFireAndForget();

    const messages = mocks.logDebug.mock.calls.map((call) => String(call[0]));
    expect(
      messages.some(
        (msg) =>
          msg.includes("plugin hook dispatch skipped") &&
          msg.includes("hook=model_call_ended") &&
          msg.includes("reason=no-hook-runner"),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (msg) =>
          msg.includes("plugin hook dispatch skipped") && msg.includes("hook=model_call_started"),
      ),
    ).toBe(true);
  });

  it("A0：runner 在场但注册表无该 hook → reason=no-hooks-registered", async () => {
    const { runner } = createHookRunnerWithRegistry([]); // 空注册表 runner（非 null）
    const wrapped = wrapWithResolver(() => runner);
    await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    await settleFireAndForget();

    const messages = mocks.logDebug.mock.calls.map((call) => String(call[0]));
    expect(
      messages.some(
        (msg) =>
          msg.includes("plugin hook dispatch skipped") &&
          msg.includes("hook=model_call_ended") &&
          msg.includes("reason=no-hooks-registered"),
      ),
    ).toBe(true);
  });
});
