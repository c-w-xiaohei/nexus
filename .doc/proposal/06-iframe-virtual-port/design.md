# 06 iframe virtual-port 方案

## 目标

为 Nexus 增加浏览器父页面与 iframe 子页面之间的第一方通信路径，并把可复用的消息总线复用能力沉到 `@nexus-js/core/transport/virtual-port`。应用侧优先使用 `@nexus-js/iframe`，只有适配器作者需要直接使用 virtual-port 子路径。

## 公共包面

- `@nexus-js/iframe` 提供 iframe 适配器。
- `@nexus-js/core/transport` 暴露适配器作者需要的核心 transport 类型和工具。
- `@nexus-js/core/transport/virtual-port` 暴露 `VirtualPortRouter` 与相关错误类型，用于在 message-bus 风格通道上复用 Nexus port。

## iframe 适配器

父页面调用 `usingIframeParent(...)`，传入 `appId`、一个或多个 `{ frameId, iframe, origin, nonce? }`，适配器为每个 iframe 建立 virtual-port router，并注册子 frame 的 descriptor。子页面调用 `usingIframeChild(...)`，传入 `appId`、`frameId`、`parentOrigin` 和可选 `nonce`，适配器通过 `window.parent.postMessage` 接入同一条逻辑通道。

两个 helper 默认直接配置共享 `nexus` 实例；传入 `configure: false` 时返回 `NexusConfig`，便于与 `services`、`policy` 或多实例配置组合。

## 安全模型

适配器在接收消息时检查 Nexus iframe envelope、`appId`、`channel`、源窗口、origin 与可选 nonce。`allowAnyOrigin: true` 才允许 `"*"` origin。适配器检查只解决传输入口可信度，业务授权仍由 core 的 `policy.canConnect` 和 `policy.canCall` 决定。

## 生命周期

父页面监听 iframe `load`，在子页面 reload 后重建该 frame 的 virtual-port router。已有 proxy 和 ref 仍绑定旧 session，不会自动迁移；调用方需要在 reload、断连或 session 替换后重新 `create()`。

## 非目标

- 不引入 Carrier、Runtime 或 VirtualPortEndpoint 之类额外概念。
- 不把 iframe 与其他 transport graph 自动合并。
- 不把 `allowAnyOrigin` 作为默认或推荐安全配置。
