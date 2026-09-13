# 多模型协作方案：主模型派发任务给子模型

[English](multi-model-orchestration.md) | 中文

> 状态：**设计 / 可行性方案（待评审）**。本文以中文为主，面向评审与后续实现。参考项目：[sst/opencode](https://github.com/sst/opencode)。

## 1. 需求理解

**你的原始诉求**（转译一致）：在当前软件（DeepSeek Harness）里实现"多模型协作"，即

> 有一个主模型（main agent / primary），它能根据任务需要，把子任务派发给其他（子）模型去干活，并汇总结果。

**关键澄清**：本项目已经具备成熟的"主 agent 派发子 agent"能力，这一点是**现状而非新需求**。真正的缺口在于三处：

1. **"按模型区分派发"的面向模型体验**：当前 `subagent` 工具是按"provider/传输方式"绑定的，模型在调用时看不到/选择不了"派给哪个心智模型"。
2. **动态路由**：opencode 允许主 agent 在调用时传 `model` 字段选择执行者；本项目目前是**配置期绑定**（一个工具实例固定一个 model）。
3. **编排原语的可组合性**：把"派发 + 汇总 + 重试 + 结果归并"暴露成一套更贴近 opencode agent/task 编排的、模型友好的原语。

## 2. 参考项目：sst/opencode 的做法

opencode（[GitHub](https://github.com/sst/opencode)，[DeepWiki](https://deepwiki.com/sst/opencode)）是一个开源的特性型 AI 编码工具，其多模型编排核心：

- **主 agent（primary）** 驱动整个会话，负责理解任务、拆解、调度。
- **子任务/子 agent 派发**：主 agent 通过 `agent` / `task` / `subtask` 类工具启动子 agent 执行独立工作；子 agent 有独立上下文。
- **模型选择**：opencode 允许在配置和调用层为每个 agent 指定模型；部分派发工具支持在调用时覆盖子任务所用模型（"runtime model override"），见 [PR #35800 · runtime model override for task tool subagents](https://github.com/anomalyco/opencode/pull/35800)。
- **编排与模式**：社区围绕它做了角色化多 agent 工作流（如 [gstack-opencode](https://github.com/yandong2023/gstack-opencode)、[Subtask2 插件](https://augmenter.dev/articles/subtask2-plugin-brings-structured-orchestration-to-opencode-commands-1768907873438/)）、[插件化并行编排](https://github.com/anomalyco/opencode/issues/20849) 等。

**对本题最相关的三点借鉴**：

| opencode 能力 | 可借鉴点 |
|---|---|
| 派发工具 + 可选模型覆盖参数 | 让模型在调用时可选执行者模型 |
| 子 agent 独立上下文 + 结果回传 | 对应本项目 spawn/fork + `report`/`.result` |
| 主/子分隔 + 角色化 | 对应本项目 persona / 工具过滤 / 深度上限 |

## 3. 现有能力盘点（DeepSeek Harness 现状）

本项目**不需要从零构建**多模型协作。已有：

- **`subagent` 能力族**（`packages/subagent/`）：
  - 子 agent 传输后端：`spawn`（全新子 agent，无父上下文）、`fork`（继承父已完成轮次）、`acp`（跨进程 ACP）、`codex`、`claude-code`、`dsh-sdk`。
  - 面向模型派发工具：`tool-subagent`（默认工具名 `subagent`，可多实例多工具名）、`tool-subagent-control`（`send_message` / `interrupt_agent` / `list_agents`）、`tool-subagent-report`（子向父回传）。
  - 能力：`persona`（子 agent 人设）、`toolFilter`（限制子工具）、`maxDepth`（嵌套深度上限）、`outputSchema`（结构化回传）、`backgroundMode`（前台 / one-shot 后台 / continuable 常驻后台可续聊）。
- **`workflow` 能力**（`packages/workflow/`）：模型写一段 JS 编排脚本，通过 `agent()` 扇出多个子 agent，适合大规模并行。
- **`plan` 模式**（`packages/plan/`）：作为带状态的系统提示，规划阶段约束主 agent。
- **`context` 插件** 与 **`todo_write`**：请求上下文加工、任务清单。
- **`agent-spine-demo` bundle**（`packages/examples/agent-spine-demo/`）：把常用服务打包成一个 Cordis 插件，示例叶子只需补上 LLM adapter / bash 执行器等变体，即可拼出可运行组合（headless / ACP / JSON-RPC 等）。
- **运行入口**：headless 单次执行、ACP 自动化服务、JSON-RPC 服务等。

**结论**："主模型=主 agent、派发子任务给子 agent"在本项目是**已实现且成熟**的能力。本方案聚焦"模型路由 + 编排体验"的增强，而非重造。

## 4. 差距分析

| 维度 | 现状 | 期望（对齐 opencode） | 建议 |
|---|---|---|---|
| 调用期选模型 | 工具实例绑定固定 `agentOptions.model`；模型无法在调用时选执行者 | 派发工具 schema 返回一个可选的 `model` 参数，主模型按任务规模/成本选 pro 或 flash | 增强 `tool-subagent` 的 schema：新增可选 `model` 参数（需校验其属于已注册模型） |
| 多个派发口 | 需要配置多个不同 `toolName` 的工具实例 | 一个派发口 + 模型选择 | 跟随上一项；保留多实例以支持配置期固定 |
| 结果归并编排 | 靠主 agent 自行协调；有 `report` / continuable | 更结构化的 orchestration 抽象 | 提供"路线图"与纯组件复用，不强制抽象 |
| 子模型后端 | 同进程 spawn/fork 或外部进程 | 混合后端共存 | 已支持多 provider 共存，直接利用 |
| 可视化/可观察 | 会话日志、`list_agents` | 编排 DAG 可视化 | 可选后续里程碑，不阻塞 |

## 5. 方案设计

### 5.1 核心模型

```
User -> main agent (e.g. deepseek-v4-pro)
          |  identifies task, decomposes, decides routing
          |- subagent(description, prompt, model?: pro|flash)   -> deep model
          |- subagent(description, prompt, model?: flash)       -> fast model
          `- waits / folds child results -> reports to user
```

- **主 agent**：会话的主动方，负责规划与调度。
- **子 agent**：独立会话（`spawn` 全新或 `fork` 继承），完成被派发的工作，通过 `.result` / `report` 回传。
- **模型路由**：偏好落地为 *按需模型覆盖参数 + 配置期默认* 的组合。

### 5.2 推荐落地点：增强 `tool-subagent`

在 `packages/subagent/tool-subagent/src/index.ts` 中为 Config 增加：

```ts
type EnhancedToolSubagentConfig = {
  /** Let the model choose the executor model per call. Each value must be a registered model id. Omitted uses the config-time `agentOptions.model` or the parent agent's model. */
  modelChoices?: string[]
}
```

- 规划（可选）：新增可选 tool 参数 `model: string`，其枚举受 `modelChoices` 约束；`execute` 阶段把该选择合并进 `agentOptions`。
- 能力校验：仅当绑定 provider 支持 `agentOptions` 覆盖（in-process spawn/fork 支持）时才显示该参数；否则关闭（fail loud）。
- 语义：动态选择执行者模型是本方案"主模型派发任务给多模型干活"的核心对齐点。

> 说明：这是对现有 `subagent` 能力的**增量增强**，不改变传输/上下文/生命周期语义，符合"插件而非 loop 改动"的约定。

### 5.3 其他编排原语（可选，非一阶段必做）

- **`workflow` 作为大规模编排口**：已存在，用于"一个编排脚本扇出很多子 agent"。
- **`plan` + `todo` 作为主 agent 规划辅助**：已存在，用于约束"先规划再执行"。
- **`report` / continuable 作为长时后台子模型**：已存在。

一阶段**不需要**新增编排抽象；复用来宾现成的 `subagent` + `workflow` 即可覆盖大多数"主派发子干活"场景。

## 6. 最小可运行示例

见 `examples/headless-agent/` 的 orchestration fixture，提供**两种跑法**：

1. **keyless mock 版**（默认，无需 API key）：用 mock LLM 模拟主模型产出一个 `subagent` 派发调用，spawn 的子 agent 用另一个 mock adapter（模拟"另一个模型"），跑通整条"主 → 子派发 → 回传"链路并断言。
2. **真模型版**：把 `multi-model-real.cordis.yml` 里主 agent 配成 `deepseek-v4-pro`，派发工具分别绑定 `deepseek-v4-pro` 与 `deepseek-v4-flash`，填上 `DEEPSEEK_API_KEY` 即用真 DeepSeek 跑通"pro 派活给 flash/pro"。

### 6.1 如何运行（keyless）

```sh
pnpm run test:e2e -t "multi-model orchestration"
```

### 6.2 如何运行（真模型）

```sh
DEEPSEEK_API_KEY=... node --import tsx/esm examples/headless-agent/tests/fixtures/headless-driver.ts examples/headless-agent/multi-model-real.cordis.yml "Split the task: hand X to the flash colleague and Y to the pro colleague."
```

## 7. 里程碑建议

| 里程碑 | 范围 | 估算 |
|---|---|---|
| M0（本方案+示例） | 设计评审 + keyless mock 演示 + 真模型配置 | 已完成（本 PR） |
| M1 调用期选模型 | 增强 `tool-subagent` schema（`modelChoices` + 可选 `model` 参数）+ 单元/快照测试 + README | 小 |
| M2 编排指南 | 中文 cookbook：主 agent 如何在一条会话里规划并派发给多个模型 | 中 |
| M3（可选）可视化 | 编排 DAG / 子任务面板 | 大 |

## 8. 风险与开放问题

- **动态选模型与缓存/前缀稳定性**：请求前缀稳定性不受影响（子任务独立会话），但需明确 KV cache 语义不跨模型共享——这符合"不同模型不同上下文"的直觉。
- **fail loud 语义**：模型若选了无效模型 id，必须在派发前拒绝（校验在 schema/tool 层，不是静默回退）。
- **权限/深度边界**：动态选模型不应放宽 `maxDepth`、`toolFilter`、权威继承等边界；只是换执行者，不换权威。
- **费用**：pro 派 flash 可省钱；flash 派 pro 会贵，是否需要默认限制属部署策略，交给配置文件（不做硬编码默认）。

## 9. 结论

「主模型派发任务给别的模型干活」在本项目**可行性高、实现面小**：核心就是对已成熟的 `subagent` 能力做"按需选模型"的增量增强。本方案已附带一个**无需 API key 即可跑通**的最小示例；填写 `DEEPSEEK_API_KEY` 即可切换为真 DeepSeek 多模型编排。
