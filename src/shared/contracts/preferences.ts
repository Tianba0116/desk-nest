// 显式偏好的数据约定（R10）。只放类型和常量。

export const NICKNAME_MAX = 20;

/** 表达方式（R10.AC-1）：只影响说话风格 */
export const STYLES = ['brief', 'lively', 'gentle'] as const;
export type Style = (typeof STYLES)[number];
export const STYLE_LABELS: Record<Style, string> = { brief: '简短', lively: '活泼', gentle: '温柔' };

export interface PreferencesDto {
  /** 用户希望被称呼的名字；null 表示没有设置 */
  nickname: string | null;
  /** 表达方式；null 表示默认 */
  style: Style | null;
  /** 0 表示从未设置 */
  revision: number;
}
