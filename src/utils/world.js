function getNearestEntityWhere(bot, predicate, maxDistance = 16) {
    let nearest = null;
    let minDist = maxDistance;
    for (const entity of Object.values(bot.entities)) {
        if (entity === bot.entity) continue;
        if (!entity.position) continue;
        const dist = entity.position.distanceTo(bot.entity.position);
        if (dist < minDist && predicate(entity)) {
            minDist = dist;
            nearest = entity;
        }
    }
    return nearest;
}

function getNearestBlock(bot, blockName, maxDistance = 16) {
    const pos = bot.entity.position.floored();
    let nearest = null;
    let minDist = Infinity;
    for (let dx = -maxDistance; dx <= maxDistance; dx++) {
        for (let dy = -maxDistance; dy <= maxDistance; dy++) {
            for (let dz = -maxDistance; dz <= maxDistance; dz++) {
                const block = bot.blockAt(pos.offset(dx, dy, dz));
                if (block && block.name.includes(blockName)) {
                    const dist = pos.distanceTo(block.position);
                    if (dist < minDist) {
                        minDist = dist;
                        nearest = block;
                    }
                }
            }
        }
    }
    return nearest;
}

function getBlocksInArea(bot, blockName, center, maxDistance = 16) {
    const pos = center.floored();
    const blocks = [];
    for (let dx = -maxDistance; dx <= maxDistance; dx++) {
        for (let dy = -maxDistance; dy <= maxDistance; dy++) {
            for (let dz = -maxDistance; dz <= maxDistance; dz++) {
                const block = bot.blockAt(pos.offset(dx, dy, dz));
                if (block && block.name.includes(blockName)) {
                    blocks.push(block);
                }
            }
        }
    }
    return blocks;
}

function isHostile(entity) {
    return entity.type === 'mob' &&
        ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'slime', 'husk', 'drowned', 'pillager', 'vindicator']
            .some(name => entity.name?.includes(name));
}

function isHuntable(entity) {
    return entity.type === 'animal' &&
        ['pig', 'cow', 'chicken', 'sheep', 'rabbit'].some(name => entity.name?.includes(name));
}

function isTameable(entity) {
    return entity.type === 'animal' &&
        ['wolf', 'cat', 'parrot', 'horse', 'donkey', 'mule', 'llama'].some(name => entity.name?.includes(name));
}

function isCrop(block) {
    return block && ['wheat', 'carrots', 'potatoes', 'beetroots'].some(name => block.name.includes(name));
}

function isMatureCrop(block) {
    if (!isCrop(block)) return false;
    return block.metadata >= 7;
}

function isLog(block) {
    return block && (block.name.includes('log') || block.name.includes('wood') || block.name.includes('stem') || block.name.includes('hyphae'));
}

function isLeaves(block) {
    return block && (block.name.includes('leaves'));
}

function isOre(block) {
    return block && (block.name.includes('_ore') || block.name === 'ancient_debris');
}

module.exports = {
    getNearestEntityWhere,
    getNearestBlock,
    getBlocksInArea,
    isHostile,
    isHuntable,
    isTameable,
    isCrop,
    isMatureCrop,
    isLog,
    isLeaves,
    isOre,
};
