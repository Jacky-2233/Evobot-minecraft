package com.example.mcapi;

public record InventoryItemSnapshot(
        int slot,
        String itemId,
        int count,
        String name,
        boolean empty
) {
}
