# cc-statistics 调研报告（功能设计借鉴）

> 调研对象：[androidZzT/cc-statistics](https://github.com/androidZzT/cc-statistics) v1.1.0
> 调研日期：2026-07-30
> **结论：不采用、不复刻 cc-statistics。仅借鉴其中部分功能的设计思路，供自研工具参考。**
> 本次重点借鉴点：**开发时长（活跃时长）功能**。

---

## 一、调研定位与范围

**结论：不采用、不复刻 cc-statistics 整体，仅借鉴其中部分功能的设计思路，供自研工具参考。**

本报告聚焦**值得借鉴的算法与口径设计**，首期落点为「开发时长」。

> 旁注：cc-statistics 的核心价值在 `cc_stats/`（纯 Python stdlib，约 7k 行）的解析与统计逻辑；UI / 框架对我们无参考意义，借鉴只取**设计思路**。

---

## 二、借鉴点：开发时长（活跃时长）功能

> 源码位置：cc_stats/analyzer.py（常量 IDLE_THRESHOLD 见 L85–86；时长计算 L652–710）。

### 2.1 它要解决的问题

最朴素的"开发时长 = 会话最后一条消息 − 第一条消息"（首尾时间差）会**严重虚高**：
午休、开会、过夜、以及 Claude Code 的 --resume 跨天续接，都会把一大段"人根本不在"的时间算进去，得到一个没有参考价值的数字。

cc-statistics 的做法是：**累加"有效活跃片段"，而不是取首尾跨度。**

### 2.2 核心设计

1. **以"对话轮次（turn）"为基本单位**
   一轮 = 用户真实发言 → AI 处理（可能含多次工具调用）→ AI 最终回复。
   遇到一条 user_real（真实用户消息）即开启新轮。

2. **把时长拆成两类**
   - **AI 时长**：轮内，从"本轮用户消息时间"到"AI 最后一条响应时间"。代表模型在工作。
   - **用户时长**：轮间，从"上一轮 AI 最后响应"到"本轮用户消息"。代表人在审查 / 编辑 / 思考。

3. **5 分钟空闲阈值（关键启发式）** —— IDLE_THRESHOLD = timedelta(minutes=5)
   用户时长只有在 0 < gap ≤ 5min 时才计入；**gap > 5 分钟视为"人离开了"**，直接丢弃。
   这一步把噪首尾跨度换算成可信的"专注时间"。

4. **活跃时长 = AI 时长 + 用户时长**；并且 **total_duration 也取"活跃时长之和"而非首尾差**（源码注释明确：避免 resume 会话跨天导致虚高）。

5. **健壮性处理**
   - 计算前**按时间戳排序**：--resume 或 subagent 消息可能乱序，排序可避免负 delta。
   - 只累计 delta.total_seconds() > 0 的片段。
   - 多会话/多周期聚合时，ai / user / active / total 分别相加；并额外存 active_minutes 供图表使用。

### 2.3 算法骨架（伪代码，对照源码）

```text
IDLE_THRESHOLD = 5 分钟
timed_msgs = 带时间戳的真实消息序列（按时间排序）

ai_total, user_total = 0, 0
turn_start, turn_last_ai, last_ai_end = None, None, None

for (ts, role) in timed_msgs:
    if role == 真实用户消息:                      # 开启新一轮
        if turn_start 且 turn_last_ai:
            ai_total += max(0, turn_last_ai - turn_start)   # 结算上一轮 AI 时长
        if last_ai_end:
            gap = ts - last_ai_end
            if 0 < gap <= IDLE_THRESHOLD:                   # 5 分钟阈值过滤
                user_total += gap
        last_ai_end = turn_last_ai
        turn_start, turn_last_ai = ts, None
    elif role in (AI回复, 工具结果):
        turn_last_ai = ts                                   # AI 工作中，更新本轮终点
# 结算最后一轮的 AI 时长 ...

active_duration = ai_total + user_total
total_duration  = active_duration        # 不用首尾差
```

### 2.4 值得直接借鉴的设计要点

- **「活跃时长」而非「首尾跨度」**：这是整个功能最核心、最值得抄的一点。任何"会话/工作时长"指标都应先问"是否在过滤掉离开时段"。
- **5 分钟空闲阈值**：把"是否还在专注"量化成一个可调常量；不同团队可调（如 10/15 分钟）。
- **AI 时长 / 人工时长 二分**：能区分"模型在跑"和"人在审编"，比单一总时长信息量大得多。
- **乱序防御 + 正值过滤**：处理 resume / 子代理消息这类现实脏数据，保证不出现负值或虚高。
- **聚合按分量相加、存分钟数**：天然支持跨会话/按日聚合与可视化。

### 2.5 移植到自研工具时的注意点

- 我们的 JSONL/数据结构若与 Claude Code 不同（如消息角色字段、时间戳字段、是否记录工具返回），轮次切分与 `role` 判定需相应调整。
- 阈值（5 分钟）建议做成配置项，并暴露给用户调；可考虑同时输出"首尾跨度"作对照，便于校准。
- 若我们的会话没有明确的"工具结果"消息，turn_last_ai 的更新口径要重新定义（例如只用 assistant 消息）。
- 建议附带单元测试覆盖：跨天 resume、单条消息、长时间空闲、乱序消息等边界（cc-statistics 自身有约 6.5k 行测试，口径稳定性靠的就是这些）。

---

## 三、后续可继续借鉴的点（待展开）

仅记录候选，按需再深入：
- **Token / 成本统计口径**（pricing.py）：模型分级计价、估算花费。
- **用量额度预测**（--rate-limit）：5 小时滚动窗口、超额变红预警。
- **多源解析**（Codex / Gemini / Cursor parser）：统一不同 AI 工具的会话格式。
- **Skill 使用统计**（--skills）：调用次数、成功率、时间分布。

> 需要哪个再细化，告诉我即可。
