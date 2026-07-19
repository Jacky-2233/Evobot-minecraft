package com.example.mcapi;

public record NearbyEntitySnapshot(
        String type,
        String name,
        double x,
        double y,
        double z,
        double distance,
        float health,
        boolean alive
) {
}
