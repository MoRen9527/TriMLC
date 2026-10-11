// LG-067 活性探针 healthz 升值面（COO 2026-10-11 排工令·三字段 jobCount/degraded/next_run_at）：
// computeNextRunAt 纯函数白盒——探针拿 next_run_at 判「调度活执行停」家族缺陷
// （healthz 假绿防御，2026-10-11 晨 8713 形 34h 僵活实证）。
// 本日约束：只落码+单测，禁 build/禁重启（uptime 连续性=21:00 双语义验收基线）。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeNextRunAt } from "../src/cron/service.js";

describe("cron healthz next_run_at (LG-067)", () => {
  test("multiple enabled jobs -> earliest future run", () => {
    const out = computeNextRunAt([
      { enabled: true, nextRunAt: "2026-10-11T06:00:00.000Z" },
      { enabled: true, nextRunAt: "2026-10-11T04:30:00.000Z" },
      { enabled: true, nextRunAt: "2026-10-11T08:15:00.000Z" },
    ]);
    assert.equal(out, "2026-10-11T04:30:00.000Z");
  });

  test("disabled jobs excluded even with earlier run", () => {
    const out = computeNextRunAt([
      { enabled: false, nextRunAt: "2026-10-11T01:00:00.000Z" },
      { enabled: true, nextRunAt: "2026-10-11T05:00:00.000Z" },
    ]);
    assert.equal(out, "2026-10-11T05:00:00.000Z");
  });

  test("empty job list -> null", () => {
    assert.equal(computeNextRunAt([]), null);
  });

  test("enabled but unscheduled (NULL nextRunAt) excluded; all-NULL -> null", () => {
    const out = computeNextRunAt([
      { enabled: true, nextRunAt: null },
      { enabled: true },
      { enabled: true, nextRunAt: null },
    ]);
    assert.equal(out, null);
  });

  test("unparseable nextRunAt silently excluded (bad row must not kill probe)", () => {
    const out = computeNextRunAt([
      { enabled: true, nextRunAt: "not-a-date" },
      { enabled: true, nextRunAt: "2026-10-11T07:00:00.000Z" },
    ]);
    assert.equal(out, "2026-10-11T07:00:00.000Z");
    assert.equal(computeNextRunAt([{ enabled: true, nextRunAt: "garbage" }]), null);
  });

  test("mixed reality shape: disabled+NULL+enabled trio picks the enabled one", () => {
    const out = computeNextRunAt([
      { enabled: false, nextRunAt: null },
      { enabled: true, nextRunAt: "2026-10-12T00:00:00.000Z" },
      { enabled: false, nextRunAt: "2026-10-11T00:30:00.000Z" },
    ]);
    assert.equal(out, "2026-10-12T00:00:00.000Z");
  });
});
