package com.example.mcapi;

public record ActiveEffectSnapshot(
        String id,
        int amplifier,
        int duration,
        boolean ambient,
        boolean showParticles,
        boolean showIcon
) {
}
