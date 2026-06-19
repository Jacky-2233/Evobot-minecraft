export function isFiniteVec3(pos: { x: number; y: number; z: number }): boolean {
    return Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z);
}
