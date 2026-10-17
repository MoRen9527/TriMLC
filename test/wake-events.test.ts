// ── LG-088 件b1 v2（F 件·CEO 2026-10-17 两裁①）唤醒事件订阅线行为锚卷 ──
// 两族：
//   A. parseWakeEvents 纯解析——标准段（507 DurationInUs 主判）/无 DurationInUs
//      配对 fallback/双缺不造数/无 507 不报/非 506/507 事件块忽略。
//   B. processWakeSegment 纯状态机——首拍基线吸收（防 restart 重放误报）/新段
//      达标报告/同段重读幂等/旧段跳过/浅睡段吸收（阈值 5min）/时长不可判吸收/
//      阈值边界（=5min 报）。
//
// 夹具形态=2026-10-17 wevtutil 实测输出（单行 XML·单引号属性·SystemTime 7 位
// 小数秒·507 EventData 带 DurationInUs）精简重构。
//
// Run: npx tsx --test test/wake-events.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWakeEvents,
  processWakeSegment,
  POWER_WAKE_MIN_DURATION_MS,
  WAKE_MONITOR_INIT,
  type WakeMonitorState,
} from '../src/power-monitor.js';

function ev(id: number, systemTime: string, extra = ''): string {
  return (
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'>` +
    `<System><Provider Name='Microsoft-Windows-Kernel-Power'/>` +
    `<EventID>${id}</EventID><TimeCreated SystemTime='${systemTime}'/>` +
    `<Channel>System</Channel></System>` +
    `<EventData>${extra}</EventData></Event>`
  );
}

const durData = (us: number) => `<Data Name='DurationInUs'>${us}</Data>`;

// 文档序=时间倒序（wevtutil /rd:true 契约）。
const XML_STANDARD = [
  ev(507, '2026-10-17T02:49:31.2532122Z', durData(705900623)),
  ev(506, '2026-10-17T02:37:45.3534800Z'),
].join('');

const XML_NO_DUR = [
  ev(507, '2026-10-17T02:11:45.1480540Z'),
  ev(506, '2026-10-17T02:10:45.1480540Z'),
].join('');

const XML_NO_DUR_NO_PAIR = ev(507, '2026-10-17T02:49:31.2532122Z');

const XML_ONLY_SLEEP = ev(506, '2026-10-17T02:37:45.3534800Z');

const XML_MIXED = [
  ev(507, '2026-10-17T02:49:31.2532122Z', durData(705900623)),
  ev(601, '2026-10-17T02:45:00.0000000Z'),
  ev(506, '2026-10-17T02:37:45.3534800Z'),
].join('');

// ── A. parseWakeEvents ──

describe('F件 b1 v2 parseWakeEvents 解析', () => {
  it('标准段：507 DurationInUs 主判时长·506 配对入睡时刻', () => {
    const seg = parseWakeEvents(XML_STANDARD);
    assert.ok(seg);
    assert.equal(seg.wakeAt, '2026-10-17T02:49:31.2532122Z');
    assert.equal(seg.sleepAt, '2026-10-17T02:37:45.3534800Z');
    assert.ok(seg.durationMs != null);
    assert.equal(Math.round(seg.durationMs!), 705901); // 705900623us ≈ 705.9s
  });

  it('无 DurationInUs：fallback 配对差（wake−sleep=60s）', () => {
    const seg = parseWakeEvents(XML_NO_DUR);
    assert.ok(seg);
    assert.equal(seg.durationMs, 60_000);
  });

  it('双缺（无 DurationInUs 无 506 配对）：durationMs=null sleepAt=null 不造数', () => {
    const seg = parseWakeEvents(XML_NO_DUR_NO_PAIR);
    assert.ok(seg);
    assert.equal(seg.sleepAt, null);
    assert.equal(seg.durationMs, null);
  });

  it('无 507（只睡未醒）：null 不报', () => {
    assert.equal(parseWakeEvents(XML_ONLY_SLEEP), null);
  });

  it('混流（含非 506/507 事件块）：忽略无关块取对正确', () => {
    const seg = parseWakeEvents(XML_MIXED);
    assert.ok(seg);
    assert.equal(seg.sleepAt, '2026-10-17T02:37:45.3534800Z');
    assert.equal(Math.round(seg.durationMs!), 705901);
  });
});

// ── B. processWakeSegment 状态机 ──

const BIG = {
  wakeAt: '2026-10-17T01:17:47.5590000Z',
  sleepAt: '2026-10-17T00:13:40.6310000Z',
  durationMs: 3_846_928, // 64min 主段（今晨实证段②）
};
const SHALLOW = {
  wakeAt: '2026-10-17T00:11:12.7350000Z',
  sleepAt: '2026-10-17T00:08:15.0960000Z',
  durationMs: POWER_WAKE_MIN_DURATION_MS - 1, // 4min59s（今晨段①浅睡）
};
// 时序递进夹具（时刻晚于 BIG——测「新段」分支必须晚于已处理段，否则走旧段跳过）
const LATER_SHALLOW = {
  wakeAt: '2026-10-17T01:25:00.0000000Z',
  sleepAt: '2026-10-17T01:20:00.0010000Z',
  durationMs: POWER_WAKE_MIN_DURATION_MS - 1,
};
const BOUNDARY = { ...BIG, durationMs: POWER_WAKE_MIN_DURATION_MS }; // =5min
const LATER_UNKNOWN = { ...LATER_SHALLOW, wakeAt: '2026-10-17T01:35:00.0000000Z', durationMs: null };

function initAbsorbed(seg: { wakeAt: string }): WakeMonitorState {
  // 基线吸收辅助：过一道首拍
  return processWakeSegment(WAKE_MONITOR_INIT, seg).state;
}

describe('F件 b1 v2 processWakeSegment 状态机', () => {
  it('首拍基线吸收：大段也只记不报（防 restart 重放历史段误报）', () => {
    const r = processWakeSegment(WAKE_MONITOR_INIT, BIG);
    assert.equal(r.report, null);
    assert.equal(r.state.baselineAbsorbed, true);
    assert.equal(r.state.lastHandledWakeAt, BIG.wakeAt);
  });

  it('基线后新段达标：报告并推进 lastHandledWakeAt', () => {
    const base = initAbsorbed(SHALLOW);
    const r = processWakeSegment(base, BIG);
    assert.ok(r.report);
    assert.equal(r.report.wakeAt, BIG.wakeAt);
    assert.equal(r.state.lastHandledWakeAt, BIG.wakeAt);
  });

  it('同段重读：幂等零报告（60s 节律下每段只评估一次）', () => {
    const base = initAbsorbed(SHALLOW);
    const once = processWakeSegment(base, BIG);
    const twice = processWakeSegment(once.state, BIG);
    assert.equal(twice.report, null);
  });

  it('更早段（晚于已处理段）：跳过不报', () => {
    const base = initAbsorbed(BIG);
    const older = { ...SHALLOW, wakeAt: '2025-01-01T00:00:00.0000000Z' };
    const r = processWakeSegment(base, older);
    assert.equal(r.report, null);
  });

  it('浅睡段（<5min）：吸收不报且 lastHandledWakeAt 推进（后续重读幂等）', () => {
    const base = initAbsorbed(BIG);
    const r = processWakeSegment(base, LATER_SHALLOW);
    assert.equal(r.report, null);
    assert.equal(r.state.lastHandledWakeAt, LATER_SHALLOW.wakeAt);
    const again = processWakeSegment(r.state, LATER_SHALLOW);
    assert.equal(again.report, null);
  });

  it('时长不可判段（durationMs=null）：吸收不报（如实边界·不猜）', () => {
    const base = initAbsorbed(BIG);
    const r = processWakeSegment(base, LATER_UNKNOWN);
    assert.equal(r.report, null);
    assert.equal(r.state.lastHandledWakeAt, LATER_UNKNOWN.wakeAt);
  });

  it('阈值边界（durationMs=5min 整）：报（< 判定语义）', () => {
    const base = initAbsorbed(SHALLOW);
    const r = processWakeSegment(base, BOUNDARY);
    assert.ok(r.report);
    assert.equal(r.report.durationMs, POWER_WAKE_MIN_DURATION_MS);
  });
});
