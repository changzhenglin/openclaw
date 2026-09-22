/**
 * Ensures runtime plugin registries are loaded for agent execution. Startup
 * plugin IDs from metadata scope the load when available.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getActivePluginRuntimeSubagentMode } from "../plugins/runtime.js";
import { ensureStandaloneRuntimePluginRegistryLoaded } from "../plugins/runtime/standalone-runtime-registry-loader.js";
import { resolveUserPath } from "../utils.js";

type StartupScopedPluginSnapshot = NonNullable<
  ReturnType<typeof getCurrentPluginMetadataSnapshot>
> & {
  startup?: {
    pluginIds?: readonly unknown[];
  };
};

function resolveStartupPluginIdsFromCurrentSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): string[] | undefined {
  const snapshot = getCurrentPluginMetadataSnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
  }) as StartupScopedPluginSnapshot | undefined;
  const pluginIds = snapshot?.startup?.pluginIds;
  if (!Array.isArray(pluginIds)) {
    return undefined;
  }
  return pluginIds.filter((pluginId): pluginId is string => typeof pluginId === "string");
}

/** Ensure standalone runtime plugins are loaded for the current agent context. */
export function ensureRuntimePluginsLoaded(params: {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
}): void {
  ensureRuntimePluginsLoadedWithRegistry(params);
}

/**
 * 同 ensureRuntimePluginsLoaded 的加载面，但返回本次 run 自身的插件注册表
 * （Ruling-187 丙案・捕获点 (b) 路线）。
 *
 * 返回值语义：
 * - fresh load / 暖 cache early-return（standalone-runtime-registry-loader.ts:63-70，
 *   不激活不重载）均返回与本次 load scope 匹配的注册表（loader 以
 *   registryContainsRuntimePluginIds 校验 scope 覆盖）——run 侧据此用共享 factory
 *   自建 hook runner，免疫全局单例被第三方 scoped 激活 last-wins 覆盖；
 * - plugins 禁用 / scope 不匹配时返回 undefined（run 侧＝显式空 scope）。
 */
export function ensureRuntimePluginsLoadedWithRegistry(params: {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
}): PluginRegistry | undefined {
  if (params.config && !normalizePluginsConfig(params.config.plugins).enabled) {
    return undefined;
  }
  const workspaceDir =
    typeof params.workspaceDir === "string" && params.workspaceDir.trim()
      ? resolveUserPath(params.workspaceDir)
      : undefined;
  const startupPluginIds = resolveStartupPluginIdsFromCurrentSnapshot({
    config: params.config,
    workspaceDir,
  });
  const allowGatewaySubagentBinding =
    params.allowGatewaySubagentBinding === true ||
    getActivePluginRuntimeSubagentMode() === "gateway-bindable";
  return ensureStandaloneRuntimePluginRegistryLoaded({
    requiredPluginIds: startupPluginIds,
    loadOptions: {
      config: params.config,
      workspaceDir,
      ...(startupPluginIds === undefined ? {} : { onlyPluginIds: startupPluginIds }),
      ...(startupPluginIds === undefined ? {} : { forceFullRuntimeForChannelPlugins: true }),
      runtimeOptions: allowGatewaySubagentBinding
        ? { allowGatewaySubagentBinding: true }
        : undefined,
    },
  });
}
