/**
 * Global Plugin Hook Runner
 *
 * Singleton hook runner that's initialized when plugins are loaded
 * and can be called from anywhere in the codebase.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { GlobalHookRunnerRegistry, HookRunnerRegistry } from "./hook-registry.types.js";
import type { PluginHookGatewayContext, PluginHookGatewayStopEvent } from "./hook-types.js";
import { createHookRunner, type HookRunner } from "./hooks.js";

type HookRunnerGlobalState = {
  hookRunner: HookRunner | null;
  registry: GlobalHookRunnerRegistry | null;
};

const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");
const getState = () =>
  resolveGlobalSingleton<HookRunnerGlobalState>(hookRunnerGlobalStateKey, () => ({
    hookRunner: null,
    registry: null,
  }));

const getLog = () => createSubsystemLogger("plugins");

/**
 * Shared HookRunner factory（Ruling-187 丙案・3A①）。
 *
 * 全局单例 runner 与 run-scoped runner（run 用自身注册表自建）必须同源 options：
 * catchErrors + 三个 fail-closed 策略 + plugins subsystem logger 接线。
 * initializeGlobalHookRunner 与 run 侧捕获点（embedded-agent-runner/run.ts）共用本工厂，
 * 避免两份 options 漂移。
 */
export function createHookRunnerWithGlobalOptions(registry: GlobalHookRunnerRegistry): HookRunner {
  const log = getLog();
  return createHookRunner(registry, {
    logger: {
      debug: (msg) => log.debug(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
    },
    catchErrors: true,
    failurePolicyByHook: {
      before_agent_run: "fail-closed",
      before_install: "fail-closed",
      before_tool_call: "fail-closed",
    },
  });
}

/**
 * A0 观测口径（Ruling-187）：注册 hook 计数 = legacy hooks + typed hooks。
 *
 * 旧口径仅计 registry.hooks.length（legacy），typed-only 注册表（现网插件常态）
 * 计数恒 0 → "hook runner initialized" 日志静默 = 覆盖发生时无痕迹盲区
 * （gateway-b3-debug.log 0 条口径面实证）。日志文案不变，仅口径修正。
 */
export function countRegisteredHooks(registry: HookRunnerRegistry): number {
  return registry.hooks.length + registry.typedHooks.length;
}

/**
 * Initialize the global hook runner with a plugin registry.
 * Called once when plugins are loaded during gateway startup.
 */
export function initializeGlobalHookRunner(registry: GlobalHookRunnerRegistry): void {
  const state = getState();
  const log = getLog();
  state.registry = registry;
  state.hookRunner = createHookRunnerWithGlobalOptions(registry);

  const hookCount = countRegisteredHooks(registry);
  if (hookCount > 0) {
    log.debug(`hook runner initialized with ${hookCount} registered hooks`);
  }
}

/**
 * Get the global hook runner.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalHookRunner(): HookRunner | null {
  return getState().hookRunner;
}

/**
 * Get the global plugin registry.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalPluginRegistry(): GlobalHookRunnerRegistry | null {
  return getState().registry;
}

/**
 * Check if any hooks are registered for a given hook name.
 */
export function hasGlobalHooks(hookName: Parameters<HookRunner["hasHooks"]>[0]): boolean {
  return getState().hookRunner?.hasHooks(hookName) ?? false;
}

export async function runGlobalGatewayStopSafely(params: {
  event: PluginHookGatewayStopEvent;
  ctx: PluginHookGatewayContext;
  onError?: (err: unknown) => void;
}): Promise<void> {
  const log = getLog();
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("gateway_stop")) {
    return;
  }
  try {
    await hookRunner.runGatewayStop(params.event, params.ctx);
  } catch (err) {
    if (params.onError) {
      params.onError(err);
      return;
    }
    log.warn(`gateway_stop hook failed: ${String(err)}`);
  }
}

/**
 * Reset the global hook runner (for testing).
 */
export function resetGlobalHookRunner(): void {
  const state = getState();
  state.hookRunner = null;
  state.registry = null;
}
