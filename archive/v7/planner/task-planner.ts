import { formatRetrieved } from '../memory/retrieval.js';
import { SkillLibrary } from '../memory/skill-library.js';
import { ExampleLibrary } from '../memory/example-library.js';
import { FailureMemory } from '../memory/failure-memory.js';

export class TaskPlannerContext {
    constructor(
        private readonly skills: SkillLibrary,
        private readonly examples: ExampleLibrary,
        private readonly failures: FailureMemory,
    ) {}

    build(userMessage: string, state: string): string {
        const query = `${userMessage}\n${state}`;
        return [
            formatRetrieved('Relevant skills', this.skills.search(query, 4)),
            formatRetrieved('Relevant command examples', this.examples.search(query, 4)),
            formatRetrieved('Recent similar failures', this.failures.search(query, 3)),
            'Planning rule: choose an intent with a verifiable success condition. If execution failed before, choose the smallest corrective action.',
        ].join('\n');
    }
}
