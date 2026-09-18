/// <reference types="vite/client" />
import agentRun from './templates/agent-run.md?raw'
import logRun from './templates/log-run.md?raw'

/**
 * 系统提示模板，按分析对象分两份。两份都 inline 进 `claude -p --append-system-prompt`；
 * 数据（digest + fileMap）一律走 userMessage。模板源文件在 `templates/`，经 Vite `?raw`
 * 构建期内联为字符串。
 *
 * 为什么要分两份而不是一份加分支：两者的**口径**不同 —— 整会话/节点诊断读的是按类别聚合的
 * 时序分桶（回答「时间花在哪」），记录表读的是逐条记录（回答「这些步骤是什么」）。
 * 一份模板塞两种数据形状，模型会拿分桶的读法去读表格。
 */
export function getSystemPrompt(): string {
  return agentRun
}

/** 日志视图「筛选后记录表」分析用的系统提示（见 templates/log-run.md）。 */
export function getLogSystemPrompt(): string {
  return logRun
}
