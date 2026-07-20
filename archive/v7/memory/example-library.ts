import { lexicalSearch, type RetrievalDocument } from './retrieval.js';

type Example = { user: string; intent: string; notes: string };

const EXAMPLES: Example[] = [
    { user: 'COME HERE / here / come', intent: 'move_to speaker position', notes: 'Use current speaking player coordinates, not old coordinates.' },
    { user: 'FOLLOW ME / continue follow me', intent: 'follow_player', notes: 'Persistent runtime task; do not spam one-shot move_to.' },
    { user: 'COLLECT WOOD PLS / collect woods', intent: 'collect target=log', notes: 'After execution verify inventory increased; if not, search for reachable logs.' },
    { user: 'USE AXE', intent: 'tool preference', notes: 'For logs, equip axe if one exists; otherwise explain no axe is available.' },
    { user: '你有什么 / what material do u have', intent: 'chat_only inventory report', notes: 'Reply from actual inventory only.' },
    { user: '你有工作台吗 / crafting table', intent: 'inventory_or_craft crafting_table', notes: 'Check inventory and nearby blocks before claiming.' },
];

export class ExampleLibrary {
    search(query: string, limit = 4): Array<RetrievalDocument<Example> & { score: number }> {
        return lexicalSearch(query, EXAMPLES.map((example, index) => ({
            id: `example:${index + 1}`,
            text: `user=${example.user}; intent=${example.intent}; notes=${example.notes}`,
            meta: example,
        })), limit);
    }
}
