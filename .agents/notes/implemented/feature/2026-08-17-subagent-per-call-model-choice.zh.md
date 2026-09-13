# Agent Note：子 agent 按调用选择模型

Status: implemented

[English](2026-08-17-subagent-per-call-model-choice.md) | 中文

## 问题

DeepSeek Harness 已经支持主模型把子任务派发给子 agent（`subagent` seam）。但子 agent 的执行者模型是在配置期绑定的：每个 `tool-subagent` 实例钉死一个 `agentOptions.model`，因此"快速子 agent"和"深度子 agent"各需要一个单独命名（不同 `toolName`）的工具实例。主模型若想在调用时把子任务路由给 `deepseek-v4-flash` 或 `deepseek-v4-pro`（opencode 式编排），没有任何模型可见的旋钮。

## 决策

`dsh-tool-subagent` 新增可选配置 `modelChoices`：一个非空、不重复的模型 id 列表。配置后，工具 schema 会暴露一个可选的 `model` 参数（这些 id 的枚举），说明调用模型可以在每次调用时选择子 agent 的执行者模型。在 `execute` 中，所选的 `model` 会合并进该次调用的 `agentOptions.model`，覆盖配置期的 `agentOptions.model`；省略 `model` 则保持配置期模型。该行为是选择加入的：没有 `modelChoices` 时 schema 不变，且一个多余的 `model` 参数会被大声拒绝，而不是被静默忽略。

合并走的是现有 `agentOptions` 契约。进程内 `spawn`/`fork` 提供方会把显式的 `agentOptions` 值视为对继承父级选项的覆盖，因此按调用选定的模型在那里生效；进程外提供方拥有自己的子预算，是否生效由该提供方自身负责。这是配置责任，而非新的能力标志——与 `agentOptions` 本身在未设置启动期能力门槛的情况下被接受的方式一致。

"大声失败"分两层强制。参数校验器会在派发前强制 schema 枚举（`"model" must be one of [...]`）。执行期保护会再次对照 `modelChoices` 校验，并拒绝实例未配置的 `model`（在 `modelChoices` 未设置且一个多余的非声明键 `model` 到达时可达，因为校验器允许非声明键）。空列表或重复的 `modelChoices` 会在插件加载时失败，从而在任何派发之前就捕获损坏的枚举。

## 测试

包测试钉死模型可见的契约：未设置 `modelChoices` 时没有 `model` 参数；配置时出现可选枚举参数；所选的 `model` 被转发进启动请求；调用时的选择仅在该次调用覆盖配置期模型；未配置时多余 `model` 被拒绝；空/重复列表在加载时失败。一个 keyless 组装应用场景运行 mock 主模型，发出一次携带 `model: "orchestration-child"` 的 `subagent` 调用，组装在 `subagent` 工具上暴露计算出的 `model` 枚举，并子 agent 的结果带着主模型的汇报被折返——这是任意会话都会走的真实组合路径。

## 备选方案

**为每种模型各建一个派发工具名。** 现状要求为 N 种可选模型配 N 个工具实例，为每次派发膨胀 schema，并把模型路由耦合到工具命名维护上。

**一个全局模型路由服务。** 为共享模型池新增 Service Definition/Provider/Consumer 比需求更广；在现有派发工具上加一个配置旋钮即可在任意会话里覆盖多模型派发，无需新 seam。

**不做校验，让提供方回退。** 那会把拼错的模型静默跑在配置期模型上——正是 `modelChoices` 要避免的失败。

## 后果

配置了 `modelChoices` 会为该工具实例的请求增加一个 schema 参数（及其枚举），因此只有选择加入的实例模型可见输入会增加。对没有该参数的实例，KV cache 前缀稳定性不受影响；加了它的实例会像任何 schema 变更那样，从第一个工具定义变化起使父级复用失效。执行者选择是逐调用、逐请求的，因此一个模型可以在同一条消息里混合 `flash` 与 `pro` 子任务；协调兄弟工作区作用与提供方配额仍是模型的责任，与其他任何一种派发一致。
