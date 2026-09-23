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

// ─── 六形态回归矩阵（Task 4 Step 1・4A 对账补缺） ─────────────────────────────
// 断言面＝丙案（e4c6437d1c）落地后的正确行为（run dispatch 免疫覆盖/暖 runtime 存活）。
// 形态→覆盖映射（本补缺后的完整矩阵）：
// ① gateway-bindable 再激活 → 本文件「RED(丙案目标)…」（主钉・既有）
//    ＋ loader.hook-runner-scoped-activation.test.ts 机制记录面（全局层）
// ② default-mode preserve → loader.hook-runner-scoped-activation.test.ts 对照组
//    （全局面・既有绿）＋ attempt.model-diagnostic-events.test.ts fallback dispatch（既有）
// ③ scoped 子集 → 本节补缺（部分子集：不缺/不多・F3 不借全局）
// ④ 懒载 cache early-return → 本文件「定案=(b)…」（dispatch 面・既有）
//    ＋ runtime-plugins.registry-reuse.test.ts「④…」（loader 面・补缺）
// ⑤ 交错激活 → 本节补缺（A带钩/B无钩/A'带钩 交替＝dreaming×inject 生产形态）
// ⑥ 暖 runtime 零加载继承 → 本节补缺（23 轮零 fire 直接机制回归钉）
describe("六形态回归矩阵补缺（③scoped 子集 / ⑤交错激活 / ⑥暖 runtime 零加载继承）", () => {
  /** run.ts bootstrap 等价：run 自身注册表＋共享 factory（3A①）自建 run 自身 runner。 */
  function makeRunScopedRunner(
    hooks: Array<{ hookName: string; handler: (...args: unknown[]) => unknown }>,
  ) {
    const { registry } = createHookRunnerWithRegistry(hooks);
    return { registry, runner: createHookRunnerWithGlobalOptions(registry) };
  }

  function wrapRunScoped(runId: string, resolveHookRunner: () => unknown) {
    return wrapStreamFnWithDiagnosticModelCallEvents(makeStreamFn(), {
      runId,
      provider: "openai",
      model: "gpt-x",
      trace: createDiagnosticTraceContext(),
      nextCallId: () => `call-${runId}`,
      resolveHookRunner,
    } as never);
  }

  async function fireOneModelCall(wrapped: ReturnType<typeof wrapRunScoped>): Promise<void> {
    await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    await settleFireAndForget();
  }

  it("③ scoped 子集：子集内钩正常 fire（不缺），子集外钩全局有也不借（不多・F3 scoped 隔离）", async () => {
    // 全局（第三方 scope 等价）带 model_call_ended——子集 run 不得借用。
    const globalEnded = vi.fn();
    const { registry: globalRegistry } = createHookRunnerWithRegistry([
      { hookName: "model_call_ended", handler: globalEnded },
    ]);
    initializeGlobalHookRunner(globalRegistry);
    expect(getGlobalHookRunner()?.hasHooks("model_call_ended")).toBe(true); // sanity: 全局确有该钩

    // run 的 scope 子集：仅 model_call_started、缺 model_call_ended（子集缺钩形态）。
    const scopedStarted = vi.fn();
    const { runner: subsetRunner } = makeRunScopedRunner([
      { hookName: "model_call_started", handler: scopedStarted },
    ]);

    await fireOneModelCall(wrapRunScoped("run-subset", () => subsetRunner));

    expect(scopedStarted).toHaveBeenCalledTimes(1); // 不缺：子集内钩正常 fire
    expect(globalEnded).not.toHaveBeenCalled(); // 不多：缺的钩不借全局
    // A0 观测面：子集缺钩留 skip 痕迹（非静默）。
    const messages = mocks.logDebug.mock.calls.map((call) => String(call[0]));
    expect(
      messages.some(
        (msg) =>
          msg.includes("plugin hook dispatch skipped") &&
          msg.includes("hook=model_call_ended") &&
          msg.includes("reason=no-hooks-registered") &&
          msg.includes("runId=run-subset"),
      ),
    ).toBe(true);
  });

  it("⑤ 交错激活：A(带钩)/B(无钩)/A'(带钩) 交替覆盖下各 run 的 dispatch 稳定归属自身 scope", async () => {
    // scope A 激活（gateway-bindable 等价）：全局=A；runA bootstrap 捕获 A 的 runner。
    const endedA = vi.fn();
    const { registry: registryA, runner: runnerA } = makeRunScopedRunner([
      { hookName: "model_call_ended", handler: endedA },
    ]);
    initializeGlobalHookRunner(registryA);
    const wrappedA = wrapRunScoped("run-A", () => runnerA);

    // scope B 激活（无钩・last-wins 覆盖全局＝dreaming 轮等价）；runB 捕获 B 的 runner。
    const { registry: registryB, runner: runnerB } = makeRunScopedRunner([]);
    initializeGlobalHookRunner(registryB);
    const wrappedB = wrapRunScoped("run-B", () => runnerB);

    // runA 在 B 覆盖后 dispatch：仍归属 A（免疫覆盖）。
    await fireOneModelCall(wrappedA);
    expect(endedA).toHaveBeenCalledTimes(1);

    // scope A' 激活（带钩・再覆盖全局＝inject 轮等价）；runA2 捕获 A' 的 runner。
    const endedA2 = vi.fn();
    const { registry: registryA2, runner: runnerA2 } = makeRunScopedRunner([
      { hookName: "model_call_ended", handler: endedA2 },
    ]);
    initializeGlobalHookRunner(registryA2);
    const wrappedA2 = wrapRunScoped("run-A2", () => runnerA2);

    // runB 在 A'(带钩) 全局下 dispatch：不 fire・不借全局（归属 B 的无钩 scope・F3）。
    await fireOneModelCall(wrappedB);
    expect(endedA2).toHaveBeenCalledTimes(0); // B 轮不借 A' 的钩
    expect(endedA).toHaveBeenCalledTimes(1); // B 轮也不触 A 的钩

    // runA2 dispatch：归属 A'・正常 fire。
    await fireOneModelCall(wrappedA2);
    expect(endedA2).toHaveBeenCalledTimes(1);

    // runA 第二次 model call：run 内缓存 runner 免疫 B/A' 交错覆盖・仍归属 A。
    await fireOneModelCall(wrappedA);
    expect(endedA).toHaveBeenCalledTimes(2);

    // A0 观测面：runB 的静默轮留 skip 痕迹（生产交错静默原为零日志）。
    const messages = mocks.logDebug.mock.calls.map((call) => String(call[0]));
    expect(
      messages.some(
        (msg) =>
          msg.includes("plugin hook dispatch skipped") &&
          msg.includes("hook=model_call_ended") &&
          msg.includes("reason=no-hooks-registered") &&
          msg.includes("runId=run-B"),
      ),
    ).toBe(true);
  });

  it("⑥ 暖 runtime 零加载继承：23 轮 inject 零新激活，每轮 run 起始捕获 runner 存活 fire（23 轮零 fire 回归钉）", async () => {
    // 暖 runtime 前提：全局单例早被第三方覆盖为无钩、此后不再激活
    // （inject 轮 ensure 命中暖 cache early-return・不激活不重载＝03:54+ 生产形态）。
    const { registry: staleGlobalRegistry } = createHookRunnerWithRegistry([]);
    initializeGlobalHookRunner(staleGlobalRegistry);
    const staleGlobalRunner = getGlobalHookRunner();
    expect(staleGlobalRunner?.hasHooks("model_call_ended")).toBe(false);

    // 暖 cache 注册表（同一对象・getLoadedRuntimePluginRegistry 命中等价）：带 model_call_ended。
    const ended = vi.fn();
    const { registry: warmRegistry } = createHookRunnerWithRegistry([
      { hookName: "model_call_ended", handler: ended },
    ]);

    const INJECT_TURNS = 23; // 对照生产 gateway-b3-debug.log 03:54+ 的 23 轮 inject
    let resolverCalls = 0;
    for (let turn = 1; turn <= INJECT_TURNS; turn += 1) {
      // 每轮＝新 run：bootstrap 用暖 cache 注册表经共享 factory 自建 runner（run.ts 等价）。
      const runScopedRunner = createHookRunnerWithGlobalOptions(warmRegistry);
      const wrapped = wrapRunScoped(`run-inject-${turn}`, () => {
        resolverCalls += 1;
        return runScopedRunner;
      });
      await fireOneModelCall(wrapped);
    }

    expect(ended).toHaveBeenCalledTimes(INJECT_TURNS); // 每轮均 fire（修复前：fallback 全局→全轮静默）
    // 每 run 只解析一次：started+ended 两处 dispatch 均命中 run 内缓存（3A②）。
    expect(resolverCalls).toBe(INJECT_TURNS);
    // 零新激活：全局单例对象未被重建（暖 cache 期间无人 initializeGlobalHookRunner）。
    expect(getGlobalHookRunner()).toBe(staleGlobalRunner);
    expect(getGlobalHookRunner()?.hasHooks("model_call_ended")).toBe(false);
  });
});
