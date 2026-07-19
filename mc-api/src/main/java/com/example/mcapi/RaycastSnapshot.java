package com.example.mcapi;

public record RaycastSnapshot(
        String hitType,
        String name,
        double x,
        double y,
        double z,
        double distance,
        boolean missed
) {
}
