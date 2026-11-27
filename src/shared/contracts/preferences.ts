// 显式偏好的数据约定（R10）。只放类型和常量。

export const NICKNAME_MAX = 20;

export interface PreferencesDto {
  /** 用户希望被称呼的名字；null 表示没有设置 */
  nickname: string | null;
  /** 0 表示从未设置 */
  revision: number;
}
