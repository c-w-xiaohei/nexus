---
title: Nexus State 常见问题
description: 关于同步远程状态的常见问题解答。
---

## 为什么不直接跨上下文使用 Zustand？ [#why-not-just-use-zustand-directly-across-contexts]

Zustand 负责本地状态管理，不处理跨上下文传输、连接生命周期、断开行为或订阅的所有权清理。

Nexus State 内部可以使用 `zustand/vanilla`，跨上下文协议和生命周期仍由 Nexus 负责。

## 真实状态在远端，为什么 `getState()` 是同步的？ [#why-is-getstate-sync-if-the-real-state-is-remote]

因为它读取本地镜像，不直接访问远程宿主。

这样既保留本地存储的读取体验，又让远程写入和生命周期保持明确。

## 为什么动作是异步的？ [#why-are-actions-async]

因为动作在宿主端执行。

此外，`await action()` 不仅等待远程函数结果，还等待调用方确认目标快照。
这不是事务提交回执；即使同步失败，动作也可能已修改宿主状态。完整的动作和断开规则见[生命周期和错误](/nexus/docs/state/lifecycle-and-errors/)。

## 为什么目标变化后旧句柄会失效，而不是自动重新绑定？ [#why-does-a-target-change-create-stale-handles-instead-of-auto-rebinding]

`RemoteStore` 句柄绑定一个目标和连接会话，自动重新绑定会掩盖生命周期变化。
State 规则见[生命周期和错误](/nexus/docs/state/lifecycle-and-errors/)，Core 句柄规则见[核心概念](/nexus/docs/concepts/#services-and-calls)。

## 作用域选择器的回退值是什么意思？ [#what-does-scope-selector-fallback-mean]

作用域没有当前 RemoteStore 句柄时，`RemoteStoreScope.useSelector()` 返回显式指定的 `fallback`。句柄替换或获取失败期间，不会继续返回从旧句柄中选出的值。

## 会话结束后，`useRemoteStore()` 会自动重建句柄吗？ [#does-useremotestore-automatically-rebuild-when-a-connection-session-ends]

不会。只有输入变化或应用显式请求时，才会替换句柄。详见[Nexus State React 指南](/nexus/docs/state/react/)。

## 远程存储作用域支持两种重连方式吗？ [#does-a-remote-store-scope-support-both-reconnect-controls]

支持。作用域 Provider 接受 `reconnectKey`，子组件也可以共享同一个 `reconnect()` 函数。参阅[Nexus State React 指南](/nexus/docs/state/react/)。

## Nexus State v1 支持增量补丁吗？ [#does-nexus-state-v1-support-patches]

公共协议不支持。Nexus State v1 以完整快照为基础。

## State 提供事务、草稿或回滚队列吗？ [#does-state-use-a-transaction-draft-or-rollback-queue]

不提供。源存储就是普通 Zustand 存储，动作不会自动串行执行或回滚。State 不提供草稿、回滚或队列协议，也不提供 `withNexusState` 中间件。

## Nexus State v1 包含 Jotai 吗？ [#does-nexus-state-v1-include-jotai]

不包含。`@nexus-js/react` 不提供 Jotai 集成。
