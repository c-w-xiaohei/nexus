---
title: Nexus State 文档
description: Nexus State 子系统概览和导航。
---

Nexus State 用于跨上下文同步远程状态。`@nexus-js/core/state` 提供不依赖 UI 框架的运行时，`@nexus-js/react` 提供 React 集成。

本节介绍 Nexus State 的配置、运行时行为和 API。

使用 `createStoreToken<Store>(id, options?)` 创建 StoreToken，再通过 `const { provider, store } = createNexusStore(token, nativeCreator, options)` 创建存储。将 `provider` 按普通服务方式注册，例如 `nexus.configure({ providers: [provider] })`；返回的 `store` 保留原生 Zustand API。绑定已有存储时，使用 `bindNexusStore(token, store, options)`。

选项中的 `snapshot` 显式选取要共享的数据，`expose` 指定允许远程调用的动作；两者都必须配置。`publishWindowMs` 默认 200 毫秒，`maxPendingSnapshots` 默认 32。

State 沿用 Core 的 `ConnectOptions`：精确目标 `target`、筛选条件 `where`、正数超时 `timeout` 和可选的 `signal`。它没有专属的默认目标或等待服务提供者选项。

通过注入模拟 `NexusInstance` 编写应用单元测试的方法，见[测试](/nexus/docs/testing/)。

## 从这里开始 [#start-here]

- 初次使用 Nexus State：[快速开始](/nexus/docs/state/quick-start/)
- 心智模型和生命周期语义：[概念](/nexus/docs/state/concepts/)
- 无 UI 依赖的 API 参考：[Core API](/nexus/docs/state/core-api/)
- React 集成指南：[React](/nexus/docs/state/react/)
- 生命周期和错误行为：[生命周期和错误](/nexus/docs/state/lifecycle-and-errors/)
- 测试指南：[测试](/nexus/docs/state/testing/)
- 常见问题：[FAQ](/nexus/docs/state/faq/)

## 导入入口 [#package-routing]

- 无 UI 依赖的运行时：`@nexus-js/core/state`（属于 `@nexus-js/core`）
- React 集成：`@nexus-js/react`
- 核心框架：`@nexus-js/core`
- 应用单元测试工具：`@nexus-js/testing`

如果要查找产品级 Nexus 文档，请前往[Nexus 文档](/nexus/docs/)。
