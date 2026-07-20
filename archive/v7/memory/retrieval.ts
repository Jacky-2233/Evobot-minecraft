export type RetrievalDocument<T = Record<string, unknown>> = {
    id: string;
    text: string;
    meta: T;
};

function tokenize(value: string): string[] {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9_\u4e00-\u9fff]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

export function lexicalSearch<T>(query: string, docs: RetrievalDocument<T>[], limit = 5): Array<RetrievalDocument<T> & { score: number }> {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];
    return docs
        .map((doc) => {
            const docTokens = tokenize(`${doc.id} ${doc.text}`);
            const docSet = new Set(docTokens);
            const overlap = queryTokens.reduce((sum, token) => sum + (docSet.has(token) ? 1 : 0), 0);
            const partial = queryTokens.reduce((sum, token) => sum + (docTokens.some((d) => d.includes(token) || token.includes(d)) ? 0.35 : 0), 0);
            return { ...doc, score: overlap + partial };
        })
        .filter((doc) => doc.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}

export function formatRetrieved<T extends Record<string, unknown>>(title: string, docs: Array<RetrievalDocument<T> & { score: number }>): string {
    if (docs.length === 0) return `${title}: none`;
    return [title, ...docs.map((doc) => `- ${doc.id}: ${doc.text}`)].join('\n');
}
