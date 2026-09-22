/**
 * hook-firing gap 复现 fixture（Ruling-187 T1・RED 基座）。
 *
 * 生产时间线对照（evidence/latency-phase1-t2/2026-09-22/gateway-b3-debug.log）：
 * - 03:44:38 gateway 启动（startup 十插件 scope・cloud-ext 不在集内）
 * - 03:46:44 per-run scoped 加载含 cloud-ext（provider-evidence hook 进全局 runner）
 * - 03:47:11 唯一一次 model_call_ended fire
 * - 03:54+  23 轮 inject（startup-scoped per-run 加载・不含 cloud-ext）→ hook 永久静默
 *
 * 机制链（静态证据锚）：
 * - loader.ts activatePluginRegistry(:1706-1721)：preserve 分支仅
 *   「incoming mode==="default" ∧ 当前活性 mode==="gateway-bindable" ∧ runner 非空」；
 *   gateway 进程内 per-run 加载恒带 allowGatewaySubagentBinding（runtime-plugins.ts:60 一带）
 *   → incoming mode==="gateway-bindable" → preserve 恒不命中 → initializeGlobalHookRunner
 *   last-wins 重建 runner（hook-runner-global.ts:32-54）。
 * - 重建所用 scoped 注册表不含 hook 插件时，dispatchModelCallEndedHook
 *   （attempt.model-diagnostic-events.ts:384-401）hasHooks=false → 静默 return 零日志。
 * - 「hook runner initialized with N」日志 0 条口径面：hookCount=registry.hooks.length
 *   仅计 legacy hooks（hook-runner-global.ts:50-53），typedHooks 不在口径内
 *   → 覆盖发生时无任何日志痕迹。
 *
 * 期望行为（修复后应 GREEN）：插件已注册的 typed hook 进入全局 runner 后，
 * 后续任意 scoped 再激活（gateway-bindable / 空 scope）不得静默丢弃（preserve/merge）。
 * 当前实现下断言失败 = 缺陷复现（RED）。
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getGlobalHookRunner, resetGlobalHookRunner } from "./hook-runner-global.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
  type TempPlugin,
} from "./loader.test-fixtures.js";

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

/** cloud-ext 等价物：注册 model_call_ended typed hook 的 scoped 插件。 */
function writeEvidenceHookPlugin(id: string): TempPlugin {
  return writePlugin({
    id,
    body: `module.exports = { id: "${id}", register(api) {
      api.on("model_call_ended", () => undefined);
    } };`,
  });
}

/** startup 十插件等价物：无 hook 的普通插件。 */
function writePlainPlugin(id: string): TempPlugin {
  return writePlugin({
    id,
    body: `module.exports = { id: "${id}", register() {} };`,
  });
}

describe("global hook runner across scoped re-activation (hook-firing gap)", () => {
  it("RED 主机制：后续 gateway-bindable scoped 激活（不含 hook 插件）不得静默丢弃 model_call_ended", () => {
    useNoBundledPlugins();
    const hookPlugin = writeEvidenceHookPlugin("evidence-hook-plugin");
    const plainPlugin = writePlainPlugin("plain-startup-plugin");

    // ① 03:46:44 等价：scoped 集含 hook 插件・gateway-bindable 激活 → runner 带钩
    loadOpenClawPlugins({
      cache: false,
      workspaceDir: hookPlugin.dir,
      config: {
        plugins: {
          load: { paths: [hookPlugin.file, plainPlugin.file] },
          allow: ["evidence-hook-plugin", "plain-startup-plugin"],
          entries: {
            "evidence-hook-plugin": { enabled: true },
            "plain-startup-plugin": { enabled: true },
          },
        },
      },
      onlyPluginIds: ["evidence-hook-plugin", "plain-startup-plugin"],
      runtimeOptions: { allowGatewaySubagentBinding: true },
    });
    expect(getGlobalHookRunner()?.hasHooks("model_call_ended")).toBe(true);

    // ② 03:54+ inject 轮等价：startup-scoped 集不含 hook 插件・仍 gateway-bindable
    //    → 现状 last-wins 重建 runner → hook 丢失（RED）；修复后应 preserve/merge → true
    loadOpenClawPlugins({
      cache: false,
      workspaceDir: plainPlugin.dir,
      config: {
        plugins: {
          load: { paths: [plainPlugin.file] },
          allow: ["plain-startup-plugin"],
          entries: {
            "plain-startup-plugin": { enabled: true },
          },
        },
      },
      onlyPluginIds: ["plain-startup-plugin"],
      runtimeOptions: { allowGatewaySubagentBinding: true },
    });
    expect(getGlobalHookRunner()?.hasHooks("model_call_ended")).toBe(true);
  });

  it("对照组（现状绿・钉 mode 判定码位）：default-mode 再激活走 preserve 分支・hook 保留", () => {
    useNoBundledPlugins();
    const hookPlugin = writeEvidenceHookPlugin("evidence-hook-plugin-default");
    const plainPlugin = writePlainPlugin("plain-startup-plugin-default");

    loadOpenClawPlugins({
      cache: false,
      workspaceDir: hookPlugin.dir,
      config: {
        plugins: {
          load: { paths: [hookPlugin.file, plainPlugin.file] },
          allow: ["evidence-hook-plugin-default", "plain-startup-plugin-default"],
          entries: {
            "evidence-hook-plugin-default": { enabled: true },
            "plain-startup-plugin-default": { enabled: true },
          },
        },
      },
      onlyPluginIds: ["evidence-hook-plugin-default", "plain-startup-plugin-default"],
      runtimeOptions: { allowGatewaySubagentBinding: true },
    });
    expect(getGlobalHookRunner()?.hasHooks("model_call_ended")).toBe(true);

    // default-mode（无 runtimeOptions）→ preserve 三条件命中 → runner 不被覆盖
    loadOpenClawPlugins({
      cache: false,
      workspaceDir: plainPlugin.dir,
      config: {
        plugins: {
          load: { paths: [plainPlugin.file] },
          allow: ["plain-startup-plugin-default"],
          entries: {
            "plain-startup-plugin-default": { enabled: true },
          },
        },
      },
      onlyPluginIds: ["plain-startup-plugin-default"],
    });
    expect(getGlobalHookRunner()?.hasHooks("model_call_ended")).toBe(true);
  });

  it("RED 变体（empty-scope :1729 路径）：空 scope gateway-bindable 激活不得清空 runner hook 面", () => {
    useNoBundledPlugins();
    const hookPlugin = writeEvidenceHookPlugin("evidence-hook-plugin-empty");
    const plainPlugin = writePlainPlugin("plain-startup-plugin-empty");

    loadOpenClawPlugins({
      cache: false,
      workspaceDir: hookPlugin.dir,
      config: {
        plugins: {
          load: { paths: [hookPlugin.file, plainPlugin.file] },
          allow: ["evidence-hook-plugin-empty", "plain-startup-plugin-empty"],
          entries: {
            "evidence-hook-plugin-empty": { enabled: true },
            "plain-startup-plugin-empty": { enabled: true },
          },
        },
      },
      onlyPluginIds: ["evidence-hook-plugin-empty", "plain-startup-plugin-empty"],
      runtimeOptions: { allowGatewaySubagentBinding: true },
    });
    expect(getGlobalHookRunner()?.hasHooks("model_call_ended")).toBe(true);

    // 空 scope（onlyPluginIds: []）→ loader.ts:1729 empty-registry 激活路径
    // incoming gateway-bindable → preserve 不命中 → runner 以 0-hook 空注册表重建（RED）
    loadOpenClawPlugins({
      cache: false,
      workspaceDir: plainPlugin.dir,
      config: {
        plugins: {
          load: { paths: [plainPlugin.file] },
          allow: ["plain-startup-plugin-empty"],
          entries: {
            "plain-startup-plugin-empty": { enabled: true },
          },
        },
      },
      onlyPluginIds: [],
      runtimeOptions: { allowGatewaySubagentBinding: true },
    });
    expect(getGlobalHookRunner()?.hasHooks("model_call_ended")).toBe(true);
  });
});
