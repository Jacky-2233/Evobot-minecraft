package com.example.mcapi;

import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;

public record ItemStackSnapshot(
        String itemId,
        int count,
        String name,
        boolean empty
) {
    public static ItemStackSnapshot fromStack(ItemStack stack) {
        if (stack.isEmpty()) {
            return ofEmpty();
        }
        return new ItemStackSnapshot(
                Registries.ITEM.getId(stack.getItem()).toString(),
                stack.getCount(),
                stack.getName().getString(),
                false
        );
    }

    public static ItemStackSnapshot ofEmpty() {
        return new ItemStackSnapshot("minecraft:air", 0, "Air", true);
    }
}
