# TheseusV2 TODO

- [ ] Memory 系统 Hermes 接口适配 (Hermes Memory Provider 桥接)
  - 目标：将 Theseus L1/L2/L3 统一分层记忆以标准接口暴露给外部 Agent (Hermes)
  - 核心工作：
    - 基于 `theseus-memory` 封装读写与装配流程
    - 支持 M1 装配（注入 Captain 先验与 L3 当前任务上下文）
    - 支持 M5 沉淀（追加 L1 不可变事件，更新 L2/L3）
    - 结合 FTS5 + WikiLink 双链反查优化召回与整理机制
