/** Verifies global hook runner sequencing, mutation, and error behavior. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

async function importHookRunnerGlobalModule() {
  return import("./hook-runner-global.js");
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
});
