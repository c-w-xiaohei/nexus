import type { CreateOptions } from "./types/config";

/**
 * 一个类型安全的、用于在运行时识别服务的标识符。
 * 它的设计核心是分离“编译时形状”与“运行时身份”。
 *
 * @template T 服务的接口（形状）类型。
 */
export class Token<T> {
  declare readonly __shape?: T;

  /**
   * @param id 一个在整个应用中用于标识此服务的唯一字符串 ID。
   * @param defaultTarget (可选) 为此令牌预设一个默认的寻址目标。
   *                      这能极大地简化 `nexus.create` 的调用。
   */
  constructor(
    public readonly id: string,
    public readonly defaultTarget?: CreateOptions<any, any, any>["target"],
  ) {}
}
