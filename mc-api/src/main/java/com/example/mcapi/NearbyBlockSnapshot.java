package com.example.mcapi;

public record NearbyBlockSnapshot(
        String blockId,
        String name,
        int x,
        int y,
        int z,
        double distance
) {
}
