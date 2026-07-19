package com.example.mcapi;

public record PlayerListEntrySnapshot(
        String name,
        String uuid,
        int latency
) {
}
