import fs from 'fs';
import path from 'path';
import { lexicalSearch, type RetrievalDocument } from './retrieval.js';

export type SkillMemory = {
    name: string;
    triggers: string[];
    steps: string[];
    success: string;
    failures: string[];
    source?: string;
    tags?: string[];
    preconditions?: string[];
    followups?: string[];
};

export type SkillPack = {
    packName: string;
    version?: string;
    inspiredBy?: string[];
    license?: string;
    skills: SkillMemory[];
};

const BUILTIN_SKILLS: SkillMemory[] = [
    {
        name: 'come_to_player',
        triggers: ['come here', 'here', 'come', 'come to me'],
        steps: ['resolve speaking player position', 'move_to player position with reachDistance 2'],
        success: 'bot is within 2-3 blocks of the player',
        failures: ['player not visible', 'path_stuck', 'target moved too far'],
        source: 'evobot_builtin',
        tags: ['movement', 'chat'],
    },
    {
        name: 'follow_player',
        triggers: ['follow me', 'continue follow me', 'follow'],
        steps: ['create follow_player runtime task', 'refresh goal while target remains visible', 'hold tolerance band'],
        success: 'bot keeps desired distance from player',
        failures: ['target_lost', 'target_too_far', 'unreachable'],
        source: 'evobot_builtin',
        tags: ['movement', 'runtime_task'],
    },
    {
        name: 'collect_wood',
        triggers: ['collect wood', 'collect woods', 'get wood', 'gather logs'],
        steps: ['find nearby log', 'equip axe if available', 'move near log', 'dig log', 'verify inventory log/planks count increased'],
        success: 'inventory contains more log/planks than before',
        failures: ['no reachable log', 'path_stuck', 'tool missing is ok but slower', 'dig timeout'],
        source: 'evobot_builtin',
        tags: ['resource', 'wood'],
    },
    {
        name: 'crafting_table',
        triggers: ['crafting table', 'make crafting table', 'do you have workbench', '工作台'],
        steps: ['ensure at least one log or four planks', 'craft planks if needed', 'craft crafting_table'],
        success: 'inventory contains crafting_table or nearby crafting_table is visible',
        failures: ['missing wood', 'recipe unavailable', 'craft timeout'],
        source: 'evobot_builtin',
        tags: ['craft', 'wood'],
    },
    {
        name: 'report_inventory',
        triggers: ['what material do you have', '你有什么', 'inventory', 'materials'],
        steps: ['read inventory', 'summarize actual item counts only'],
        success: 'reply matches current inventory',
        failures: ['stale state', 'hallucinated item'],
        source: 'evobot_builtin',
        tags: ['chat', 'report'],
    },
];

export class SkillLibrary {
    private skills: SkillMemory[];

    constructor(
        private readonly userDir = path.join(process.cwd(), 'memories', 'skills'),
        private readonly packDir = path.join(process.cwd(), 'src-ts-v7', 'knowledge', 'skill-packs'),
        private readonly voyagerDir = path.join(process.cwd(), 'memories', 'voyager-skill-library'),
    ) {
        this.skills = [
            ...BUILTIN_SKILLS,
            ...this.loadSkillPacks(this.packDir),
            ...this.loadVoyagerSkillLibrary(this.voyagerDir),
            ...this.loadLooseSkills(this.userDir),
        ];
    }

    search(query: string, limit = 4): Array<RetrievalDocument<SkillMemory> & { score: number }> {
        const docs = this.skills.map((skill) => ({
            id: skill.name,
            text: [
                `source=${skill.source ?? 'unknown'}`,
                `tags=${(skill.tags ?? []).join(', ')}`,
                `triggers=${skill.triggers.join(', ')}`,
                `preconditions=${(skill.preconditions ?? []).join(', ')}`,
                `steps=${skill.steps.join(' -> ')}`,
                `success=${skill.success}`,
                `failures=${skill.failures.join(', ')}`,
                `followups=${(skill.followups ?? []).join(', ')}`,
            ].join('; '),
            meta: skill,
        }));
        return lexicalSearch(query, docs, limit);
    }

    list(): string {
        return this.skills.map((skill) => skill.name).join(', ');
    }

    private loadSkillPacks(dir: string): SkillMemory[] {
        try {
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir)
                .filter((file) => file.endsWith('.json'))
                .flatMap((file) => {
                    try {
                        const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as SkillPack | SkillMemory[] | SkillMemory;
                        if (Array.isArray(parsed)) return parsed.map((skill) => this.normalizeSkill(skill, file));
                        if ('skills' in parsed && Array.isArray(parsed.skills)) return parsed.skills.map((skill) => this.normalizeSkill(skill, parsed.packName || file, parsed));
                        return [this.normalizeSkill(parsed as SkillMemory, file)];
                    } catch {
                        return [];
                    }
                })
                .filter((skill): skill is SkillMemory => Boolean(skill?.name && Array.isArray(skill?.steps)));
        } catch {
            return [];
        }
    }

    private loadLooseSkills(dir: string): SkillMemory[] {
        try {
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir)
                .filter((file) => file.endsWith('.json'))
                .flatMap((file) => {
                    try {
                        const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
                        return Array.isArray(parsed) ? parsed.map((skill) => this.normalizeSkill(skill, file)) : [this.normalizeSkill(parsed, file)];
                    } catch {
                        return [];
                    }
                })
                .filter((skill): skill is SkillMemory => Boolean(skill?.name && Array.isArray(skill?.steps)));
        } catch {
            return [];
        }
    }

    private loadVoyagerSkillLibrary(rootDir: string): SkillMemory[] {
        try {
            if (!fs.existsSync(rootDir)) return [];

            const skillDir = this.resolveVoyagerSkillDir(rootDir);
            if (!skillDir) return [];

            const descriptionDir = path.join(skillDir, 'description');
            const skillsJsonPath = path.join(skillDir, 'skills.json');
            const descriptions = new Map<string, string>();

            if (fs.existsSync(descriptionDir)) {
                for (const file of fs.readdirSync(descriptionDir)) {
                    if (!file.endsWith('.txt')) continue;
                    const name = file.replace(/\.txt$/i, '');
                    try {
                        descriptions.set(name, fs.readFileSync(path.join(descriptionDir, file), 'utf-8').trim());
                    } catch {}
                }
            }

            const fromDescriptions = Array.from(descriptions.entries()).map(([name, text]) =>
                this.voyagerDescriptionToSkill(name, text),
            );

            const fromSkillsJson = fs.existsSync(skillsJsonPath)
                ? this.loadVoyagerSkillsJson(skillsJsonPath, descriptions)
                : [];

            const merged = new Map<string, SkillMemory>();
            for (const skill of [...fromDescriptions, ...fromSkillsJson]) {
                if (!skill?.name) continue;
                merged.set(skill.name, skill);
            }
            return Array.from(merged.values());
        } catch {
            return [];
        }
    }

    private resolveVoyagerSkillDir(rootDir: string): string | null {
        const direct = path.join(rootDir, 'skill');
        if (fs.existsSync(direct)) return direct;
        for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const candidate = path.join(rootDir, entry.name, 'skill');
            if (fs.existsSync(candidate)) return candidate;
        }
        return null;
    }

    private loadVoyagerSkillsJson(skillsJsonPath: string, descriptions: Map<string, string>): SkillMemory[] {
        try {
            const parsed = JSON.parse(fs.readFileSync(skillsJsonPath, 'utf-8')) as any;
            const values = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.skills) ? parsed.skills : Object.values(parsed || {});
            return values.flatMap((entry: any) => {
                const name = String(entry?.name || entry?.skill || entry?.id || '').trim();
                if (!name) return [];
                const description = descriptions.get(name) || String(entry?.description || '').trim();
                return [this.voyagerDescriptionToSkill(name, description, entry)];
            });
        } catch {
            return [];
        }
    }

    private voyagerDescriptionToSkill(name: string, description: string, raw?: any): SkillMemory {
        const text = (description || '').replace(/\s+/g, ' ').trim();
        const triggers = this.extractVoyagerTriggers(name, text, raw);
        const steps = this.extractVoyagerSteps(name, text);
        return {
            name,
            triggers,
            steps: steps.length > 0 ? steps : [`execute learned behavior: ${name}`],
            success: raw?.success || text || `successfully execute ${name}`,
            failures: [
                'execution error',
                'missing preconditions',
                'path blocked',
                'environment mismatch',
            ],
            source: 'voyager_import',
            tags: ['voyager', 'imported_skill'],
            preconditions: raw?.preconditions || [],
            followups: raw?.followups || [],
        };
    }

    private extractVoyagerTriggers(name: string, description: string, raw?: any): string[] {
        const explicit = Array.isArray(raw?.triggers) ? raw.triggers.map((v: unknown) => String(v)) : [];
        const normalized = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
        const words = normalized.split(/\s+/).filter(Boolean);
        const heuristics = [normalized];
        if (words.includes('collect')) heuristics.push(`collect ${words.at(-1) ?? ''}`.trim(), `get ${words.at(-1) ?? ''}`.trim());
        if (words.includes('craft')) heuristics.push(`craft ${words.slice(1).join(' ')}`.trim(), `make ${words.slice(1).join(' ')}`.trim());
        if (description.toLowerCase().includes('fish')) heuristics.push('catch fish', 'go fishing');
        return Array.from(new Set([...explicit, ...heuristics].filter(Boolean)));
    }

    private extractVoyagerSteps(name: string, description: string): string[] {
        const text = description.replace(/\s+/g, ' ').trim();
        const sentenceParts = text.split(/[.;]/).map((part) => part.trim()).filter(Boolean);
        if (sentenceParts.length > 1) return sentenceParts.slice(0, 5);
        const lowered = `${name} ${text}`.toLowerCase();
        if (lowered.includes('collect')) return ['locate target', 'move into range', 'collect target', 'verify inventory changed'];
        if (lowered.includes('craft')) return ['ensure materials', 'open crafting context', 'craft item', 'verify output exists'];
        if (lowered.includes('fish')) return ['equip fishing tool', 'cast line', 'wait for bite', 'reel in', 'verify fish collected'];
        if (lowered.includes('smelt')) return ['ensure furnace and fuel', 'insert input', 'wait for smelt', 'verify output exists'];
        return text ? [text] : [`execute ${name}`];
    }

    private normalizeSkill(skill: SkillMemory, source: string, pack?: SkillPack): SkillMemory {
        return {
            ...skill,
            source: skill.source || pack?.packName || source,
            tags: skill.tags ?? [],
            preconditions: skill.preconditions ?? [],
            followups: skill.followups ?? [],
        };
    }
}
