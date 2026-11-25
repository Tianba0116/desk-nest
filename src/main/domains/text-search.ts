// 中文搜索：规范化后的子串匹配（TD §3.2、R06.AC-3）。
// 不使用 FTS5：默认分词器不切中文，trigram 要求至少 3 个字，“简历”这类两字词会搜不到。

/** 全半角（NFKC）、大小写、连续空白统一 */
export function normalizeForSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** 把查询拆成若干词，每个词都要命中（AND） */
export function searchTerms(query: string): string[] {
  return normalizeForSearch(query)
    .split(' ')
    .filter((term) => term.length > 0)
    .slice(0, 8);
}

/** LIKE 模式：转义 % _ \\，配合 ESCAPE '\\' 使用 */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
}

/** 生成 “search_text LIKE ? ESCAPE '\\' AND ...” 条件和参数 */
export function likeConditions(column: string, terms: string[]): { sql: string; params: string[] } {
  return {
    sql: terms.map(() => `${column} LIKE ? ESCAPE '\\'`).join(' AND '),
    params: terms.map(likePattern),
  };
}
