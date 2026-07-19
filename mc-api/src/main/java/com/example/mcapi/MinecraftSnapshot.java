package com.example.mcapi;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.PlayerListEntry;
import net.minecraft.entity.Entity;
import net.minecraft.entity.effect.StatusEffectInstance;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.registry.entry.RegistryEntry;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.Difficulty;
import net.minecraft.world.World;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public record MinecraftSnapshot(
        boolean inGame,

        double x, double y, double z,
        int blockX, int blockY, int blockZ,
        float yaw, float pitch, float headYaw,

        float health, float maxHealth, float absorption,
        int foodLevel, float saturation, float exhaustion,
        int armor,
        int selectedSlot,

        ItemStackSnapshot mainHand,
        ItemStackSnapshot offHand,
        ItemStackSnapshot helmet,
        ItemStackSnapshot chestplate,
        ItemStackSnapshot leggings,
        ItemStackSnapshot boots,

        List<InventoryItemSnapshot> inventory,

        float xpProgress,
        int xpLevel,
        int totalXp,
        int air, int maxAir,
        float fallDistance,
        boolean onGround, boolean alive, boolean onFire, boolean wet,
        boolean inLava, boolean submerged, boolean sneaking,
        boolean sprinting, boolean swimming, boolean gliding,
        boolean flying, boolean creativeFlying, boolean sleeping,
        float walkSpeed, float flySpeed,

        List<ActiveEffectSnapshot> effects,

        String dimension,
        String biome,
        String difficulty,
        boolean hardcore,
        long timeOfDay,
        String dayTime,
        int moonPhase,
        String gamemode,

        String serverAddress,
        int ping,
        String serverBrand,
        List<PlayerListEntrySnapshot> playerList,

        List<NearbyEntitySnapshot> nearbyEntities,
        List<NearbyBlockSnapshot> nearbyBlocks,

        Map<String, Boolean> keys
) {
    public static MinecraftSnapshot capture(Map<String, Boolean> keyStates) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client == null || client.player == null || client.world == null) {
            return empty(keyStates);
        }

        var player = client.player;
        var world = client.world;
        var inv = player.getInventory();

        // Armor slots
        ItemStack helmetStack = inv.armor.get(0);
        ItemStack chestStack = inv.armor.get(1);
        ItemStack legsStack = inv.armor.get(2);
        ItemStack bootsStack = inv.armor.get(3);
        ItemStack offHandStack = inv.offHand.get(0);

        // Effects
        List<ActiveEffectSnapshot> effects = new ArrayList<>();
        for (StatusEffectInstance effect : player.getStatusEffects()) {
            effects.add(new ActiveEffectSnapshot(
                    effect.getEffectType().getKey().map(k -> k.getValue().toString()).orElse("unknown"),
                    effect.getAmplifier(),
                    effect.getDuration(),
                    effect.isAmbient(),
                    effect.shouldShowParticles(),
                    effect.shouldShowIcon()
            ));
        }

        // Full inventory
        List<InventoryItemSnapshot> inventory = new ArrayList<>(inv.size());
        for (int slot = 0; slot < inv.size(); slot++) {
            ItemStack stack = inv.getStack(slot);
            inventory.add(new InventoryItemSnapshot(
                    slot,
                    Registries.ITEM.getId(stack.getItem()).toString(),
                    stack.getCount(),
                    stack.getName().getString(),
                    stack.isEmpty()
            ));
        }

        // Day/time
        long time = world.getTimeOfDay() % 24000;
        String dayTime;
        if (time < 1000) {
            dayTime = "dawn";
        } else if (time < 12000) {
            dayTime = "day";
        } else if (time < 13000) {
            dayTime = "sunset";
        } else {
            dayTime = "night";
        }

        int moonPhase = world.getMoonPhase();

        // Server / player list
        String serverAddress = null;
        int ping = 0;
        String serverBrand = null;
        List<PlayerListEntrySnapshot> playerList = List.of();

        if (client.getCurrentServerEntry() != null) {
            serverAddress = client.getCurrentServerEntry().address;
            serverBrand = client.getServer() != null ? client.getServer().getServerModName() : null;
        }
        if (player.networkHandler != null) {
            ping = player.networkHandler.getPlayerList().stream()
                    .filter(e -> e.getProfile().getId().equals(player.getUuid()))
                    .findFirst()
                    .map(PlayerListEntry::getLatency)
                    .orElse(0);

            playerList = player.networkHandler.getPlayerList().stream()
                    .map(e -> new PlayerListEntrySnapshot(
                            e.getProfile().getName(),
                            e.getProfile().getId().toString(),
                            e.getLatency()
                    ))
                    .toList();
        }

        List<NearbyEntitySnapshot> nearbyEntities = new ArrayList<>();
        for (Entity entity : world.getEntities()) {
            if (entity == null || entity == player) continue;
            double distance = player.distanceTo(entity);
            if (distance > 24.0) continue;
            nearbyEntities.add(new NearbyEntitySnapshot(
                    entity.getType().toString(),
                    entity.getName().getString(),
                    entity.getX(), entity.getY(), entity.getZ(),
                    distance,
                    entity instanceof net.minecraft.entity.LivingEntity living ? living.getHealth() : 0.0f,
                    entity.isAlive()
            ));
        }

        List<NearbyBlockSnapshot> nearbyBlocks = new ArrayList<>();
        int radius = 8;
        for (int dx = -radius; dx <= radius; dx++) {
            for (int dy = -4; dy <= 4; dy++) {
                for (int dz = -radius; dz <= radius; dz++) {
                    BlockPos pos = player.getBlockPos().add(dx, dy, dz);
                    var state = world.getBlockState(pos);
                    if (state.isAir()) continue;
                    String blockId = Registries.BLOCK.getId(state.getBlock()).toString();
                    if (!(blockId.contains("log") || blockId.contains("ore") || blockId.contains("stone") || blockId.contains("crafting_table") || blockId.contains("water") || blockId.contains("furnace"))) {
                        continue;
                    }
                    double distance = Math.sqrt(player.squaredDistanceTo(pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5));
                    if (distance > 16.0) continue;
                    nearbyBlocks.add(new NearbyBlockSnapshot(
                            blockId,
                            state.getBlock().getName().getString(),
                            pos.getX(), pos.getY(), pos.getZ(),
                            distance
                    ));
                }
            }
        }

        // Biome
        var biomeKey = world.getBiome(player.getBlockPos()).getKey();
        String biome = biomeKey.map(k -> k.getValue().toString()).orElse("unknown");

        // Dimension
        String dimension = world.getRegistryKey().getValue().toString();

        // Difficulty
        String difficulty = switch (world.getDifficulty()) {
            case PEACEFUL -> "peaceful";
            case EASY -> "easy";
            case NORMAL -> "normal";
            case HARD -> "hard";
            default -> "unknown";
        };

        // Game mode
        String gamemode = "unknown";
        if (client.interactionManager != null) {
            gamemode = switch (client.interactionManager.getCurrentGameMode()) {
                case SURVIVAL -> "survival";
                case CREATIVE -> "creative";
                case ADVENTURE -> "adventure";
                case SPECTATOR -> "spectator";
                default -> "unknown";
            };
        }

        return new MinecraftSnapshot(
                true,
                player.getX(), player.getY(), player.getZ(),
                player.getBlockX(), player.getBlockY(), player.getBlockZ(),
                player.getYaw(), player.getPitch(), player.getHeadYaw(),
                player.getHealth(), player.getMaxHealth(), player.getAbsorptionAmount(),
                player.getHungerManager().getFoodLevel(),
                player.getHungerManager().getSaturationLevel(),
                player.getHungerManager().getExhaustion(),
                player.getArmor(),
                inv.selectedSlot,
                ItemStackSnapshot.fromStack(player.getMainHandStack()),
                ItemStackSnapshot.fromStack(offHandStack),
                ItemStackSnapshot.fromStack(helmetStack),
                ItemStackSnapshot.fromStack(chestStack),
                ItemStackSnapshot.fromStack(legsStack),
                ItemStackSnapshot.fromStack(bootsStack),
                inventory,
                player.experienceProgress,
                player.experienceLevel,
                player.totalExperience,
                player.getAir(), player.getMaxAir(),
                player.fallDistance,
                player.isOnGround(), player.isAlive(), player.isOnFire(), player.isWet(),
                player.isInLava(), player.isSubmergedInWater(), player.isSneaking(),
                player.isSprinting(), player.isSwimming(), player.isFallFlying(),
                player.getAbilities().flying, player.getAbilities().allowFlying, player.isSleeping(),
                player.getMovementSpeed(), player.getAbilities().getFlySpeed(),
                effects,
                dimension, biome, difficulty, world.getLevelProperties().isHardcore(),
                time, dayTime, moonPhase, gamemode,
                serverAddress, ping, serverBrand, playerList,
                nearbyEntities,
                nearbyBlocks,
                Map.copyOf(keyStates)
        );
    }

    private static MinecraftSnapshot empty(Map<String, Boolean> keyStates) {
        return new MinecraftSnapshot(
                false,
                0.0, 0.0, 0.0,
                0, 0, 0,
                0.0f, 0.0f, 0.0f,
                0.0f, 0.0f, 0.0f,
                0, 0.0f, 0.0f,
                0,
                -1,
                ItemStackSnapshot.ofEmpty(),
                ItemStackSnapshot.ofEmpty(),
                ItemStackSnapshot.ofEmpty(),
                ItemStackSnapshot.ofEmpty(),
                ItemStackSnapshot.ofEmpty(),
                ItemStackSnapshot.ofEmpty(),
                List.of(),
                0.0f, 0, 0,
                0, 0,
                0.0f,
                false, false, false, false,
                false, false, false,
                false, false, false,
                false, false, false,
                0.0f, 0.0f,
                List.of(),
                "unknown", "unknown", "unknown", false, 0L, "unknown", 0, "unknown",
                null, 0, null, List.of(),
                List.of(),
                List.of(),
                Map.copyOf(keyStates)
        );
    }
}
