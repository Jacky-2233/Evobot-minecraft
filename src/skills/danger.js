const DANGEROUS_BLOCKS = ['lava', 'fire', 'soul_fire', 'campfire', 'soul_campfire', 'magma_block', 'cactus', 'sweet_berry_bush'];

/**
 * Lightweight danger awareness: only reacts to immediate hazards.
 * Path-ahead hazards (cliffs, lava ahead) are left to mineflayer-pathfinder,
 * because forcibly stopping pathfinder has been observed to cause position NaN.
 */
class DangerAwareness {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
        this.lastDangerLog = 0;
        this.lastAvoidTime = 0;
    }

    log(msg) {
        if (Date.now() - this.lastDangerLog > 3000) {
            this.agent.log(msg);
            this.lastDangerLog = Date.now();
        }
    }

    isDangerous(block) {
        if (!block) return false;
        return DANGEROUS_BLOCKS.some(name => block.name.includes(name));
    }

    isDrowning(feet, legs, head) {
        return feet?.name === 'water' && legs?.name === 'water' && head?.name === 'water';
    }

    checkImmediateDanger() {
        const bot = this.bot;
        const pos = bot.entity.position;
        const feet = bot.blockAt(pos);
        const legs = bot.blockAt(pos.offset(0, 1, 0));
        const head = bot.blockAt(pos.offset(0, 2, 0));
        const ground = bot.blockAt(pos.offset(0, -1, 0));

        if (this.isDangerous(feet) || this.isDangerous(legs)) {
            return { danger: 100, reason: 'standing in ' + (feet?.name || legs?.name) };
        }
        if (this.isDangerous(head)) {
            return { danger: 90, reason: 'head in ' + head.name };
        }
        if (this.isDangerous(ground)) {
            return { danger: 80, reason: 'standing on ' + ground.name };
        }
        if (this.isDrowning(feet, legs, head)) {
            return { danger: 85, reason: 'drowning' };
        }
        return { danger: 0, reason: null };
    }

    /**
     * Main safety check used by ModeController.
     * Only intervenes for immediate hazards; avoids pathfinder conflicts.
     */
    async reactToDanger() {
        if (this.agent.config.bot.dangerCheckEnabled === false) return { triggered: false };
        if (Date.now() - this.lastAvoidTime < 500) return { triggered: false };

        const immediate = this.checkImmediateDanger();
        if (immediate.danger >= 80) {
            this.lastAvoidTime = Date.now();
            this.log(`[Danger] ${immediate.reason}!`);
            await this.avoid(immediate.reason);
            return { triggered: true, reason: immediate.reason };
        }

        return { triggered: false, reason: null };
    }

    async avoid(reason) {
        const bot = this.bot;

        // Fire/lava/cactus/magma: do NOT stop pathfinder; just sprint backwards and jump.
        // This gives pathfinder a chance to recover on its own and avoids NaN from forced interruption.
        if (reason.includes('lava') || reason.includes('fire') || reason.includes('magma') || reason.includes('cactus')) {
            bot.setControlState('back', true);
            bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 400));
            bot.setControlState('back', false);
            bot.setControlState('jump', false);
            return;
        }

        // Drowning: jump up for air
        if (reason.includes('drown')) {
            bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 800));
            bot.setControlState('jump', false);
        }
    }
}

module.exports = DangerAwareness;
