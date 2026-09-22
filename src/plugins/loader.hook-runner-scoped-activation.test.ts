/**
 * hook-firing gap 机制记录 fixture（Ruling-187 T1 RED 基座 → Ruling-3 改造为
 * document-the-bug 机制记录面：如实断言全局 runner last-wins 覆盖现状）。
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
 * 【F4 迁移注记（plan-eng-review codex remedy・2026-09-22）】
 * RED→GREEN 证据链主面已迁至 dispatch 可观察行为层：
 * `src/agents/embedded-agent-runner/run/attempt.model-diagnostic-events.hook-scope.test.ts`
 * （丙案修 dispatch 消费路径・不触碰全局覆盖行为→本文件断言在丙案落地后不会自然转绿）。
 *
 * 【Ruling-3 改造（控制器裁决・2026-09-22）：已改造为机制记录面】
 * 本文件两条原 RED 断言改造为 document-the-bug 机制记录断言——如实钉住现状
 * last-wins 覆盖行为（gateway-bindable scoped 再激活 → 全局 runner 以新 scope 注册表
 * 重建 → hasHooks=false）。丙案不改变全局覆盖行为本身（run 侧免疫走 dispatch 层
 * resolver，钉在 hook-scope.test.ts）；保留机制记录的价值＝若未来有人改
 * preserve/merge 语义，本文件会以断言失败提示行为变更。
 * default-mode preserve 对照组保留为绿（现状正确行为回归钉）。
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
  it("机制记录（Ruling-3・document-the-bug）：后续 gateway-bindable scoped 激活（不含 hook 插件）last-wins 重建全局 runner → hook 面丢失", () => {
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
    //    → preserve 分支不命中（incoming mode ≠ default）→ initializeGlobalHookRunner
    //    last-wins 重建 runner → hook 丢失。如实记录现状（丙案不改全局层・run 侧
    //    免疫钉在 hook-scope.test.ts；若未来改 preserve/merge 语义本断言会失败提示）。
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
    expect(getGlobalHookRunner()?.hasHooks("model_call_ended")).toBe(false);
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

  it("机制记录（Ruling-3・document-the-bug）：空 scope gateway-bindable 激活以 0-hook 空注册表重建 runner → hook 面清空", () => {
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
    // incoming gateway-bindable → preserve 不命中 → runner 以 0-hook 空注册表重建。
    // 如实记录现状（Ruling-3 机制记录面・丙案不改全局层）。
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
    expect(getGlobalHookRunner()?.hasHooks("model_call_ended")).toBe(false);
  });
});
