/** Verifies global hook runner sequencing, mutation, and error behavior. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

// T5-F2（codex P2）：A0 log 口径断言用 subsystem logger spy——typed-only 用例若只看
// hasHooks，口径退回 legacy-only（registry.hooks.length）仍绿；必须钉住
// initializeGlobalHookRunner 发出的 "hook runner initialized with N registered hooks"
// 中 N＝legacy+typed 总数（hook-runner-global.ts:74-77 消费 countRegisteredHooks）。
const subsystemMocks = vi.hoisted(() => ({
  logDebug: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
}));

vi.mock("../logging/subsystem.js", () => {
  const noop = () => {};
  const logger = {
    subsystem: "plugins",
    isEnabled: () => false,
    trace: noop,
    debug: subsystemMocks.logDebug,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    raw: noop,
    child: () => logger,
  };
  return { createSubsystemLogger: () => logger };
});

async function importHookRunnerGlobalModule() {
  return import("./hook-runner-global.js");
}

function initializedHookCountMessages(): number[] {
  // 提取 "hook runner initialized with N registered hooks" 的 N（可能多条，全取）。
  return subsystemMocks.logDebug.mock.calls
    .map((call) => String(call[0]))
    .flatMap((message) => {
      const match = /hook runner initialized with (\d+) registered hooks/.exec(message);
      return match ? [Number(match[1])] : [];
    });
}

type HookRunnerGlobalModule = Awaited<ReturnType<typeof importHookRunnerGlobalModule>>;
type HookRunner = NonNullable<ReturnType<HookRunnerGlobalModule["getGlobalHookRunner"]>>;

function expectGlobalHookRunner(
  runner: ReturnType<HookRunnerGlobalModule["getGlobalHookRunner"]>,
): HookRunner {
  if (runner === null) {
    throw new Error("Expected global hook runner");
  }
  expect(typeof runner.hasHooks).toBe("function");
  return runner;
}

async function expectGlobalRunnerState(expected: { hasRunner: boolean; registry?: unknown }) {
  const mod = await importHookRunnerGlobalModule();
  expect(mod.getGlobalHookRunner() === null).toBe(!expected.hasRunner);
  if ("registry" in expected) {
    expect(mod.getGlobalPluginRegistry()).toBe(expected.registry ?? null);
  }
  return mod;
}

beforeEach(() => {
  subsystemMocks.logDebug.mockReset();
});

afterEach(async () => {
  const mod = await importHookRunnerGlobalModule();
  mod.resetGlobalHookRunner();
});

describe("hook-runner-global", () => {
  async function createInitializedModule() {
    const modA = await importHookRunnerGlobalModule();
    const registry = createMockPluginRegistry([{ hookName: "message_received", handler: vi.fn() }]);
    modA.initializeGlobalHookRunner(registry);
    return { modA, registry };
  }

  it("preserves the initialized runner across module reloads", async () => {
    const { modA, registry } = await createInitializedModule();
    expect(expectGlobalHookRunner(modA.getGlobalHookRunner()).hasHooks("message_received")).toBe(
      true,
    );

    vi.resetModules();

    const modB = await expectGlobalRunnerState({ hasRunner: true, registry });
    expect(expectGlobalHookRunner(modB.getGlobalHookRunner()).hasHooks("message_received")).toBe(
      true,
    );
  });

  it("clears the shared state across module reloads", async () => {
    await createInitializedModule();

    vi.resetModules();

    const modB = await expectGlobalRunnerState({ hasRunner: true });
    modB.resetGlobalHookRunner();
    expect(modB.getGlobalHookRunner()).toBeNull();
    expect(modB.getGlobalPluginRegistry()).toBeNull();

    vi.resetModules();

    await expectGlobalRunnerState({ hasRunner: false });
  });

  it("A0: countRegisteredHooks 口径 = legacy hooks + typed hooks", async () => {
    const mod = await importHookRunnerGlobalModule();
    // createMockPluginRegistry 同一注册进 legacy hooks(1) 与 typedHooks(1)。
    const registry = createMockPluginRegistry([{ hookName: "model_call_ended", handler: vi.fn() }]);
    expect(mod.countRegisteredHooks(registry)).toBe(2);

    // 纯 legacy（typed 空）与纯 typed（legacy 空）分别只计自身，验证不再漏计 typed。
    expect(
      mod.countRegisteredHooks({
        hooks: [{ pluginId: "p", entry: {}, events: [], source: "test" }],
        typedHooks: [],
      } as never),
    ).toBe(1);
    expect(
      mod.countRegisteredHooks({
        hooks: [],
        typedHooks: [{ pluginId: "p", hookName: "model_call_ended", handler: vi.fn() }],
      } as never),
    ).toBe(1);
    expect(mod.countRegisteredHooks({ hooks: [], typedHooks: [] })).toBe(0);
  });

  it("A0: initializeGlobalHookRunner 用 countRegisteredHooks 口径（typed-only 注册表也计入 hookCount）", async () => {
    const mod = await importHookRunnerGlobalModule();
    // typed-only 注册表（legacy hooks 空）——旧口径 registry.hooks.length=0 会漏计，
    // 新口径应 = 1，故 initialized runner 对该 typed hook hasHooks=true。
    const registry = createMockPluginRegistry([{ hookName: "model_call_ended", handler: vi.fn() }]);
    registry.hooks.length = 0; // 强制 typed-only
    expect(mod.countRegisteredHooks(registry)).toBe(1);
    mod.initializeGlobalHookRunner(registry);
    expect(expectGlobalHookRunner(mod.getGlobalHookRunner()).hasHooks("model_call_ended")).toBe(
      true,
    );
  });

  it("A0: typed-only 注册表初始化发出 log 且 N＝legacy+typed 总数（log 口径钉）", async () => {
    // T5-F2（codex P2）：hasHooks 查 typedHooks、与 A0 log 口径无关——口径退回
    // legacy-only（registry.hooks.length）时上面 hasHooks 用例仍绿。本用例钉住
    // initializeGlobalHookRunner 的 debug log：legacy 0 + typed 2 → N=2
    // （旧口径 hooks.length=0 → hookCount>0 不成立 → 零日志 = 覆盖发生无痕迹盲区）。
    const mod = await importHookRunnerGlobalModule();
    const registry = createMockPluginRegistry([
      { hookName: "model_call_started", handler: vi.fn() },
      { hookName: "model_call_ended", handler: vi.fn() },
    ]);
    registry.hooks.length = 0; // 强制 typed-only（legacy 0 + typed 2）
    expect(mod.countRegisteredHooks(registry)).toBe(2);

    mod.initializeGlobalHookRunner(registry);

    expect(initializedHookCountMessages()).toEqual([2]);
  });

  it("A0: legacy-only 注册表对照——log N＝legacy 计数（typed 空不漏报）", async () => {
    const mod = await importHookRunnerGlobalModule();
    const registry = createMockPluginRegistry([{ hookName: "model_call_ended", handler: vi.fn() }]);
    registry.typedHooks.length = 0; // 强制 legacy-only（legacy 1 + typed 0）
    expect(mod.countRegisteredHooks(registry)).toBe(1);

    mod.initializeGlobalHookRunner(registry);

    expect(initializedHookCountMessages()).toEqual([1]);
  });
});
