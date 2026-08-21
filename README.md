# TriMLC

TriMLC（Meta Local Controller，元虚拟本地控制器）＝本地研发仓 claude code 宿主的模块化承接点，与服务器端 TriMMC 共同构成元虚拟系统最小实现。

## 文档同步元信息

- sourceOfTruth: TriMLC/README.md
- syncMode: source-only
- lastSyncedAt: 2026-08-22

## 模块定位（一句话）

TriMLC 是元虚拟系统的本地腿：本地研发仓 claude code 原版宿主经 FADE 发布线完成激活，未来经 ssh+bridge 与 TriMMC 通信（bridge 客户端形态）。

依据：CEO 2026-08-21 重定义简报 §一.3；R4 架构分析 §2.1/§七；CEO 六决策④（TriMLC 保留定名＋文档锚定）。

## 职责边界

1. 本地宿主激活：用 FADE 多宿主发布线把员工定义灌入本地 claude code 宿主——当前最小功能面仅此一项（CEO 定调「目前主要就这点功能（最小）」）。
2. bridge 客户端（后续批次，本仓零实现）：ssh LocalForward 隧道消费 TriMMC HTTP 三原语（spawn/list/send），归 R6 bridge-1 线。
3. 明确不做（元虚拟「不做」清单，R5 §1.1）：会话生命周期管理、自研 agent loop（元虚拟侧零 agent-core）、跨 agent 上下文聚合、多 agent 运行时注册表、跨节点可见性——全部归宿主原生能力或归元现实侧。

## 无 daemon 侦听面声明

TriMLC 无 daemon、无侦听面、无常驻服务（R4 §七安全模型裁决：bridge 客户端形态，ssh 密钥即其全部鉴权面）。本仓不承载任何运行时代码；任何 daemon/侦听面/运行时新增均属边界违反，须先升级 CTO 与 BusinessStrategy 裁决。

## FADE claude 宿主激活口径

TriMLC 的本地宿主激活走 FADE 发布宿主线（claude 宿主）。本节当前为口径声明：实际 binding/live 渲染发布归后续批次。FADE 发布线就绪基线：双宿主重渲染 12+12 收敛、binding 13/13 零 error（git b15e53e2 / 72022a4e）。

## 命名消歧

TriMLC ≠ TriModel。TriMLC＝系统层（元虚拟本地腿）；TriModel＝组件层（Provider/Model 统一配置，npm 包名 `trimodel`）。口语读法：TriModel 读 "Tri-Model"（2 音节），TriMLC 拼读 "Tri-M-L-C"（4 音节）。消歧条目真源：`../TriMetaverse/docs/三元宇宙架构与模块说明.md` §5（v0.5）。

## 相关真源

- 架构定位：`../TriMetaverse/docs/三元宇宙架构与模块说明.md`（§4 模块表 TriMLC 行 + §5 命名消歧条目）
- 立项依据树：`../TriMetaverse/docs/workflow/operating-records/2026-W34/trees/tmv-minimal-restructure-analysis/`（CEO 简报 + R1-R9）
- 立项状态与四件套清单：`STATE.md`
