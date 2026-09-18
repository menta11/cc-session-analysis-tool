// vitest 全局 setup：所有测试都跑在 Node 上，安装 Node 版的 FsBridge 与 ProcBridge。
//
// 为什么集中在 setup 而不是每个测试文件里：`core/` 已把 syscall（fs）与子进程（proc）抽成
// 可注入的桥（见 core/fsBridge.ts / core/procBridge.ts），测试必须先把桥装上。
// 集中装一次，既有 233 条测试就不用逐个改 import —— 这正是"只换 IO 层"这个架构决定的收益。
import { installNodeFsBridge } from '../../core/fsBridgeNode'
import { installNodeProcBridge } from '../../core/procBridgeNode'

installNodeFsBridge()
installNodeProcBridge()
