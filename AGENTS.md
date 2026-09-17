# TriMLC Agent Rules

> 正名注记（2026-09-18 merge 窗，CTO 裁）：TriLC→TriMLC 正名演进中；本文件以现役开发期事实为主体，远端立项期描述已并入。registry 双名并存（TriLC*/TriMLC*）为 merge 态合法形态，名轨正名属后续治理批。

## Module Role

- TriMLC（原 TriLC）是本地域控制器（M 面 daemon，8713）。
- 它负责 detached local runtime、本地节点升级、planner、tool bus 和本地执行生命周期。
- 立项期规划的 ssh+bridge 与 TriMMC 通信（bridge 客户端形态）为演进路径（R4 裁决），非现役形态。
- 当商业模式涉及本地域执行、节点升级或本地工具能力时，必须考虑本模块。

## Strategy Delegation

- 总商业模式、是否把本地域作为当前实验重点、与服务域或移动端的边界，先咨询 `TriMetaverse/BusinessStrategy`。

## Local Fact Sources

- 产品事实：`README.md`
- 代码事实：`src/runtime/`、`src/local-node/`、`src/planner/`、`src/toolbus/`、`src/context-adapter/`
- 立项事实：`STATE.md`
- 治理事实：`../TriMetaverse/docs/三元宇宙架构与模块说明.md`（§4 模块表 / §5 命名消歧）

## Current Registries

- `TriMLCBusinessStrategyRegistry`
- `TriMLCProductRegistry`
- `TriMLCCodeRegistry`
- 并存期注记：`TriLC*Registry` 旧名件双名并存（CTO 裁：不删不并，名轨正名属后续治理批）。

当前 registry agent canonical discovery 位于 `TriMLC/.github/agents/`，已在 TriCompany 发布 manifest 登记（module-local-live-entry）。同名中央 discovery 文件不应在 `TriMetaverse/.github/agents/` 并行保留；中央只通过 manifest 和 registry closeout 工作流路由本模块 registry。

## Update Discipline

- 当前事实不足时应标为待确认，尤其不要虚构本地域节点成熟度。
- TriMLC ≠ TriModel（消歧条目见架构文档 §5）；两名词不得混用。
