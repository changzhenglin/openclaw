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
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../plugins/hook-runner-global.js";
import { createHookRunnerWithRegistry } from "../../../plugins/hooks.test-helpers.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";

afterEach(() => {
  resetGlobalHookRunner();
});

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    // no-op drain
  }
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
