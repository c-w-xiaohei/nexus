/**
 * 一个独特的 Symbol，用于在代理对象上附加一个确定的释放句柄。
 * 使用 Symbol 可以避免与远程对象的属性名发生冲突。
 */
export const RELEASE_PROXY_SYMBOL = Symbol.for("nexus.proxy.release");
