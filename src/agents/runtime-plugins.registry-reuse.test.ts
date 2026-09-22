// Verifies runtime plugin loading can reuse a compatible gateway startup registry.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHookRunnerWithGlobalOptions,
  getGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";

const mocks = vi.hoisted(() => ({
  getCurrentPluginMetadataSnapshot: vi.fn(),
  loadOpenClawPlugins: vi.fn<typeof import("../plugins/loader.js").loadOpenClawPlugins>(),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: mocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../plugins/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/loader.js")>();
  return {
    ...actual,
    loadOpenClawPlugins: (...args: Parameters<typeof mocks.loadOpenClawPlugins>) =>
      mocks.loadOpenClawPlugins(...args),
  };
});

const [
  { ensureRuntimePluginsLoaded, ensureRuntimePluginsLoadedWithRegistry },
  { clearPluginLoaderCache, testing },
] = await Promise.all([import("./runtime-plugins.js"), import("../plugins/loader.js")]);

function createRegistryWithPlugin(pluginId: string): PluginRegistry {
  // Minimal active registry carrying just enough plugin identity for reuse checks.
  const registry = createEmptyPluginRegistry();
  registry.plugins.push({
    id: pluginId,
    status: "loaded",
  } as never);
  return registry;
}

beforeEach(() => {
  mocks.getCurrentPluginMetadataSnapshot.mockReset();
  mocks.loadOpenClawPlugins.mockReset();
});

afterEach(() => {
  clearPluginLoaderCache();
  resetPluginRuntimeStateForTest();
  resetGlobalHookRunner();
});

describe("ensureRuntimePluginsLoaded registry reuse", () => {
  it("reuses the compatible gateway startup registry on the dispatch caller path", () => {
    // Matching cache key plus gateway-bindable mode means no second plugin load.
    const config = { plugins: { allow: ["telegram"] } };
    const activeRegistry = createRegistryWithPlugin("telegram");
    activeRegistry.coreGatewayMethodNames = ["sessions.get", "sessions.list"];
    const startupLoadOptions = {
      config,
      activationSourceConfig: config,
      autoEnabledReasons: {},
      workspaceDir: "/tmp/workspace",
      onlyPluginIds: ["telegram"],
      coreGatewayMethodNames: ["sessions.get", "sessions.list"],
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
      preferBuiltPluginArtifacts: true,
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(startupLoadOptions);
    setActivePluginRegistry(activeRegistry, cacheKey, "gateway-bindable", "/tmp/workspace");
    mocks.getCurrentPluginMetadataSnapshot.mockReturnValue({
      startup: {
        pluginIds: ["telegram"],
      },
    });
    mocks.loadOpenClawPlugins.mockImplementation(() => {
      throw new Error("dispatch should reuse the active gateway startup registry");
    });

    ensureRuntimePluginsLoaded({
      config,
      workspaceDir: "/tmp/workspace",
    });

    expect(mocks.getCurrentPluginMetadataSnapshot).toHaveBeenCalledWith({
      config,
      workspaceDir: "/tmp/workspace",
    });
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("④ 懒载 cache early-return：暖 cache 命中返回 run 自身注册表且不激活全局 runner——共享 factory 自建 runner 仍带钩（Task 4 六形态矩阵・loader 面）", () => {
    // 生产对照：inject 轮 ensureStandaloneRuntimePluginRegistryLoaded 命中
    // getLoadedRuntimePluginRegistry 暖 cache（standalone-runtime-registry-loader.ts:61-71）
    // → 不 loadOpenClawPlugins、不 activatePluginRegistry（全局单例不刷新）→ early-return
    // 缓存注册表。丙案捕获点 (b)：run 用该返回值经共享 factory 自建 hook runner
    // （run.ts bootstrap 等价）——dispatch 面回归钉在 hook-scope.test.ts「定案=(b)」。
    const config = { plugins: { allow: ["telegram"] } };
    const activeRegistry = createRegistryWithPlugin("telegram");
    // 注册表带 model_call_ended typed hook（cloud-ext provider-evidence hook 等价）。
    activeRegistry.typedHooks.push({
      pluginId: "telegram",
      hookName: "model_call_ended",
      handler: () => undefined,
      priority: 0,
      source: "test",
    } as never);
    // cacheKey 与 ensureRuntimePluginsLoadedWithRegistry 实际派生的 loadOptions 同构计算
    // （startup snapshot=["telegram"] → onlyPluginIds＋forceFullRuntimeForChannelPlugins；
    // active mode=gateway-bindable → runtimeOptions）——命中判定不依赖真实插件发现面
    // （partial node_modules 环境下发现面与 CI 不同・完整 startup 形态 options 会 key 漂移）。
    const derivedLoadOptions = {
      config,
      workspaceDir: "/tmp/workspace",
      onlyPluginIds: ["telegram"],
      forceFullRuntimeForChannelPlugins: true,
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(derivedLoadOptions);
    setActivePluginRegistry(activeRegistry, cacheKey, "gateway-bindable", "/tmp/workspace");
    mocks.getCurrentPluginMetadataSnapshot.mockReturnValue({
      startup: {
        pluginIds: ["telegram"],
      },
    });
    mocks.loadOpenClawPlugins.mockImplementation(() => {
      throw new Error("cache hit must not reload plugins");
    });
    expect(getGlobalHookRunner()).toBeNull(); // 暖 cache 前提：全局单例未被激活

    const returned = ensureRuntimePluginsLoadedWithRegistry({
      config,
      workspaceDir: "/tmp/workspace",
    });

    expect(returned).toBe(activeRegistry); // early-return＝run 自身注册表（同一对象・不重载的决定性证据）
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled(); // 不重载
    expect(getGlobalHookRunner()).toBeNull(); // 不激活：cache 路径不触碰全局单例
    // run 自身 runner 仍正确：共享 factory（3A①）自建 → 带钩（免疫全局无钩态）。
    const runScopedRunner = createHookRunnerWithGlobalOptions(returned as PluginRegistry);
    expect(runScopedRunner.hasHooks("model_call_ended")).toBe(true);
  });
});
