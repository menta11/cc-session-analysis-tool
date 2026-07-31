/// <reference types="vite/client" />
import agentRun from './templates/agent-run.md?raw'

/**
 * 单一系统提示模板（整会话 / 节点诊断共用）。
 * inline 进 `claude -p --append-system-prompt`；数据（digest + fileMap）走 userMessage。
 * 模板源文件 `templates/agent-run.md`，经 Vite `?raw` 构建期内联为字符串。
 */
export function getSystemPrompt(): string {
  return agentRun
}
