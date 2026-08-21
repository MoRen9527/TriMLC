# TriMLC Agent Rules

## Module Role

- TriMLC 是元虚拟本地控制器（Meta Local Controller）。
- 它承接本地研发仓 claude code 原版宿主的激活与治理入口：经 FADE 发布宿主线灌入员工定义，未来经 ssh+bridge 与 TriMMC 通信（bridge 客户端形态）。
- 无 daemon、无侦听面、无常驻服务；本仓不承载任何运行时代码。
- 当任务涉及本地宿主激活、元虚拟本地腿或 bridge-1 客户端时，必须考虑本模块。

## Strategy Delegation

- 总商业模式、元虚拟/元现实边界、TriMLC 是否进入当前实验路径，先咨询 `TriMetaverse/BusinessStrategy`。

## Local Fact Sources

- 产品事实：`README.md`
- 立项事实：`STATE.md`
- 治理事实：`../TriMetaverse/docs/三元宇宙架构与模块说明.md`（§4 模块表 / §5 命名消歧）

## Current Registries

- `TriMLCBusinessStrategyRegistry`
- `TriMLCProductRegistry`
- `TriMLCCodeRegistry`

当前 registry agent canonical discovery 位于 `TriMLC/.github/agents/`，已在 TriCompany 发布 manifest 登记（module-local-live-entry）。同名中央 discovery 文件不应在 `TriMetaverse/.github/agents/` 并行保留；中央只通过 manifest 和 registry closeout 工作流路由本模块 registry。

## Update Discipline

- 本仓当前为零代码立项态：禁止虚构功能面、daemon、bridge 实现或宿主激活进度。
- 任何运行时/侦听面/daemon 新增均违反 R4 裁决（bridge 客户端形态），须先升级 CTO 与 `BusinessStrategy`。
- TriMLC ≠ TriModel（消歧条目见架构文档 §5）；两名词不得混用。
