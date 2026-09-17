# TriMLC 立项状态

## 文档同步元信息

- sourceOfTruth: TriMLC/STATE.md
- syncMode: source-only
- lastSyncedAt: 2026-08-24

## 立项事实

- 立项日期：2026-08-22
- 立项批次：TMV-P1-4（期 1「定名立项＋开业互锁」TriMLC 立项批，R6 §五）
- 决策依据：CEO 2026-08-21 六决策④——TriMLC 保留定名＋文档锚定（否决 TriMVLC，保 M/R × MC/LC 2×2 对称）
- 架构依据：R4 §2.1/§七（bridge 客户端形态、无 daemon 侦听面）；R5 §四（命名锚定三层落地）；R6 §1.2（最小功能面＝本地宿主激活，本体零新代码）
- 当前状态：已立项——仓骨架＋立项四件套落盘；零运行时代码、零 daemon、零侦听面

## 立项四件套清单（AGENTS 对齐 TODO ⑥ 新模块标准）

| 件 | 落点 | 状态 |
| --- | --- | --- |
| AGENTS.md 五段式模板 | `TriMLC/AGENTS.md` | 已落 |
| registry 三件套（contract 化轻量声明） | `TriMLC/.github/agents/TriMLCBusinessStrategyRegistry.agent.md`、`TriMLCProductRegistry.agent.md`、`TriMLCCodeRegistry.agent.md`（各内嵌「模块合同」段） | 已落；正式 `.contract.yaml` 与运行时加载归 TODO-3 定调后再补 |
| manifest 登记 | `TriCompany/source-agents/registries/trimetaverse-live-agent-publish-manifest.json`（module-local-live-entry × 3） | 已登记 |
| 知识命名空间预留 | `module/trimlc`（见下节声明） | 已声明 |

口径注：R6 §1.2 表述为「contract/agent-body/registry/发布条目」，与 `agent-governance-alignment-design.md` §六 定义（AGENTS.md 模板 / registry 三件套 / manifest 登记 / 知识命名空间预留）有出入；本立项按文档定义执行（任务指令明确以文档为准）。

## 知识命名空间预留

- 命名空间：`module/trimlc`（模块记忆＋知识注入内容层，AGENTS 对齐 TODO ⑥ 第 4 件）
- 当前为预留声明；runtime 认知侧命名空间扩展机制归 AGENTS 对齐 TODO-8，未接线前本命名空间无消费方。

## 待办（后续批次）

1. ~~git init ＋ dev 分支 ＋ 首次 commit~~ ✅ 已完成（磁盘实证：dev 分支，791ffa1 立项 + 3c98147 更正；2026-08-24 quadmig-4 Q4-2 核销，原记录系立项批无 shell 权限时的预登记）
2. `docs/` 六件套骨架（engineering/product/registry/workflow/training/execution）——架构文档 §2＋company-governance-state.md「模块标配」纪律项，本批未建；缺失标配按治理条款由 CTO 在发现当轮或下一轮优先补齐
3. 本地 CodeGraph 初始化——同上骨架纪律项，本批未建；补齐 owner 同上（CTO）
4. FADE claude 宿主实际发布（binding/live 渲染）——口径已立，发布归后续批次
5. bridge-1 客户端实现（ssh 隧道＋三原语转发）——R6 bridge 线，依赖 TriMMC 侧 token＋收环先行

## quad-migration 关联（2026-08-24）

- 本模块 = 元虚拟系统对本地腿（TriMMC+TriMLC），四模块迁移说明书 v1.0 §2.1/Phase 4 在册：`docs/execution/2026-08-24/quad-migration-spec.md`
- 命名锚定：大写连写=叙事名；勿混 TriModel（组件层）。权威 alias 表：TriCompany/docs/registry/company-governance-state.md
