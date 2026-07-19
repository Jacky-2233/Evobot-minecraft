package com.example.mcapi;

import net.minecraft.client.MinecraftClient;
import net.minecraft.entity.Entity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.screen.ScreenHandler;
import net.minecraft.screen.slot.SlotActionType;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.EntityHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

import baritone.api.BaritoneAPI;
import baritone.api.pathing.goals.GoalBlock;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.ArrayList;
import java.util.concurrent.CompletableFuture;

public final class McApiActions {
    private McApiActions() {
    }

    private static int countMatching(MinecraftClient client, String namePart) {
        int count = 0;
        if (client.player == null) return 0;
        for (int slot = 0; slot < client.player.getInventory().size(); slot++) {
            ItemStack stack = client.player.getInventory().getStack(slot);
            if (!stack.isEmpty()) {
                String id = Registries.ITEM.getId(stack.getItem()).toString();
                if (id.contains(namePart)) count += stack.getCount();
            }
        }
        return count;
    }

    private static Map<String, Integer> inventorySnapshot(MinecraftClient client) {
        Map<String, Integer> snapshot = new HashMap<>();
        if (client.player == null) return snapshot;
        for (int slot = 0; slot < client.player.getInventory().size(); slot++) {
            ItemStack stack = client.player.getInventory().getStack(slot);
            if (!stack.isEmpty()) {
                String id = Registries.ITEM.getId(stack.getItem()).toString();
                snapshot.merge(id, stack.getCount(), Integer::sum);
            }
        }
        return snapshot;
    }

    private static Map<String, Integer> inventoryDelta(Map<String, Integer> before, Map<String, Integer> after) {
        Map<String, Integer> delta = new HashMap<>();
        for (String key : before.keySet()) {
            int diff = after.getOrDefault(key, 0) - before.get(key);
            if (diff != 0) delta.put(key, diff);
        }
        for (String key : after.keySet()) {
            if (!before.containsKey(key)) {
                delta.put(key, after.get(key));
            }
        }
        return delta;
    }

    public static CompletableFuture<McApiActionResult> breakBlock(Double tx, Double ty, Double tz, long timeoutMs) {
        CompletableFuture<McApiActionResult> future = new CompletableFuture<>();
        new Thread(() -> {
            MinecraftClient client = MinecraftClient.getInstance();
            if (client == null || client.player == null || client.world == null) {
                future.complete(new McApiActionResult(false, "not in game", Map.of(), Map.of()));
                return;
            }
            PlayerEntity player = client.player;
            Map<String, Integer> beforeInv = inventorySnapshot(client);
            long start = System.currentTimeMillis();
            final boolean[] blockRemoved = {false};
            final BlockPos[] targetPos = {null};
            final String[] targetBlockId = {null};
            boolean useExplicitTarget = tx != null && ty != null && tz != null;

            if (useExplicitTarget) {
                targetPos[0] = BlockPos.ofFloored(tx, ty, tz);
            }

            // Look at target and hold attack key
            while (System.currentTimeMillis() - start < timeoutMs) {
                final BlockPos[] currentPos = {null};

                client.execute(() -> {
                    if (useExplicitTarget) {
                        BlockPos pos = targetPos[0];
                        Vec3d eye = player.getEyePos();
                        Vec3d targetCenter = new Vec3d(pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5);
                        double dx = targetCenter.x - eye.x;
                        double dy = targetCenter.y - eye.y;
                        double dz = targetCenter.z - eye.z;
                        double h = Math.sqrt(dx * dx + dz * dz);
                        player.setYaw((float) (Math.atan2(dz, dx) * 180.0 / Math.PI - 90.0));
                        player.setPitch((float) (-Math.atan2(dy, h) * 180.0 / Math.PI));
                        currentPos[0] = pos;
                    } else {
                        if (client.crosshairTarget instanceof BlockHitResult bhr) {
                            currentPos[0] = bhr.getBlockPos();
                        }
                    }
                    if (currentPos[0] != null) {
                        var state = client.world.getBlockState(currentPos[0]);
                        if (!state.isAir()) {
                            targetBlockId[0] = Registries.BLOCK.getId(state.getBlock()).toString();
                            client.options.attackKey.setPressed(true);
                        } else {
                            client.options.attackKey.setPressed(false);
                            blockRemoved[0] = true;
                        }
                    }
                });

                try { Thread.sleep(150); } catch (InterruptedException e) { break; }

                // Check if target block became air
                if (targetPos[0] != null) {
                    final boolean[] isAir = {false};
                    client.execute(() -> {
                        isAir[0] = client.world.getBlockState(targetPos[0]).isAir();
                    });
                    try { Thread.sleep(50); } catch (InterruptedException ignored) {}
                    if (isAir[0]) {
                        blockRemoved[0] = true;
                        break;
                    }
                }
            }

            // Release key
            client.execute(() -> client.options.attackKey.setPressed(false));
            try { Thread.sleep(50); } catch (InterruptedException ignored) {}

            Map<String, Integer> afterInv = inventorySnapshot(client);
            Map<String, Integer> delta = inventoryDelta(beforeInv, afterInv);
            Map<String, Object> verifier = new HashMap<>();
            verifier.put("blockRemoved", blockRemoved[0]);
            verifier.put("inventoryDelta", delta);
            if (targetBlockId[0] != null) verifier.put("targetBlockId", targetBlockId[0]);
            if (targetPos[0] != null) verifier.put("targetPos", Map.of("x", targetPos[0].getX(), "y", targetPos[0].getY(), "z", targetPos[0].getZ()));

            if (blockRemoved[0] || !delta.isEmpty()) {
                future.complete(new McApiActionResult(true, "block broken: " + targetBlockId[0], delta, verifier));
            } else {
                future.complete(new McApiActionResult(false, "block not broken within timeout", delta, verifier));
            }
        }, "mc-api-break").start();
        return future;
    }

    public static CompletableFuture<McApiActionResult> attackEntity(String targetName, long timeoutMs) {
        CompletableFuture<McApiActionResult> future = new CompletableFuture<>();
        new Thread(() -> {
            MinecraftClient client = MinecraftClient.getInstance();
            if (client == null || client.player == null || client.world == null) {
                future.complete(new McApiActionResult(false, "not in game", Map.of(), Map.of()));
                return;
            }

            String target = targetName.toLowerCase();
            PlayerEntity player = client.player;
            long start = System.currentTimeMillis();
            boolean entityKilled = false;
            String entityName = targetName;
            Map<String, Integer> beforeInv = inventorySnapshot(client);

            while (System.currentTimeMillis() - start < timeoutMs) {
                final LivingEntity[] found = {null};
                final double[] foundDist = {Double.MAX_VALUE};

                client.execute(() -> {
                    double bestDist = 20.0;
                    for (Entity e : client.world.getEntities()) {
                        if (e == null || e == player || !e.isAlive()) continue;
                        String ename = e.getName().getString().toLowerCase();
                        if (!ename.contains(target)) continue;
                        double d = player.distanceTo(e);
                        if (d < bestDist) {
                            bestDist = d;
                            foundDist[0] = d;
                            if (e instanceof LivingEntity le) found[0] = le;
                        }
                    }
                });

                try { Thread.sleep(50); } catch (InterruptedException ignored) {}

                if (found[0] != null) {
                    entityName = found[0].getName().getString();
                    if (foundDist[0] > 3.5) {
                        try {
                            var pos = found[0].getPos();
                            var moveResult = moveTo(pos.x, pos.y, pos.z, 2.0, 5000).get();
                            if (!moveResult.ok()) {
                                future.complete(new McApiActionResult(false, "cannot reach target: " + entityName, Map.of(), Map.of("entityName", entityName)));
                                return;
                            }
                        } catch (Exception ignored) {}
                    }
                    client.execute(() -> {
                        if (found[0].isAlive()) {
                            try {
                                net.minecraft.util.math.Vec3d eyePos = found[0].getEyePos();
                                net.minecraft.util.math.Vec3d playerPos = player.getEyePos();
                                double dx = eyePos.x - playerPos.x;
                                double dy = eyePos.y - playerPos.y;
                                double dz = eyePos.z - playerPos.z;
                                double h = Math.sqrt(dx * dx + dz * dz);
                                player.setYaw((float) (Math.atan2(dz, dx) * 180.0 / Math.PI - 90.0));
                                player.setPitch((float) (-Math.atan2(dy, h) * 180.0 / Math.PI));
                                client.interactionManager.attackEntity(player, found[0]);
                                player.swingHand(Hand.MAIN_HAND);
                            } catch (Exception ignored) {}
                        }
                    });

                    try { Thread.sleep(400); } catch (InterruptedException ignored) {}

                    final boolean[] stillAlive = {true};
                    client.execute(() -> { stillAlive[0] = found[0].isAlive(); });
                    if (!stillAlive[0]) {
                        entityKilled = true;
                        break;
                    }
                } else {
                    try { Thread.sleep(200); } catch (InterruptedException ignored) {}
                }
            }

            Map<String, Object> verifier = new HashMap<>();
            Map<String, Integer> afterInv = inventorySnapshot(client);
            Map<String, Integer> delta = inventoryDelta(beforeInv, afterInv);
            verifier.put("entityKilled", entityKilled);
            verifier.put("entityName", entityName);
            verifier.put("inventoryDelta", delta);

            if (entityKilled) {
                future.complete(new McApiActionResult(true, "killed " + entityName, delta, verifier));
            } else {
                future.complete(new McApiActionResult(false, "entity not killed: " + entityName, delta, verifier));
            }
        }, "mc-api-attack").start();
        return future;
    }

    public static CompletableFuture<McApiActionResult> moveTo(double tx, double ty, double tz, double reachDistance, long timeoutMs) {
        CompletableFuture<McApiActionResult> future = new CompletableFuture<>();
        new Thread(() -> {
            MinecraftClient client = MinecraftClient.getInstance();
            if (client == null || client.player == null || client.world == null) {
                future.complete(new McApiActionResult(false, "not in game", Map.of(), Map.of()));
                return;
            }

            PlayerEntity player = client.player;
            long start = System.currentTimeMillis();
            final double[] lastX = {player.getX()};
            final double[] lastZ = {player.getZ()};
            final double[] lastY = {player.getY()};
            final long[] stuckStart = {0};
            final int[] stuckPhase = {0};
            final long[] phaseStart = {0};

            client.execute(() -> KeyController.stopAll(client, new java.util.concurrent.ConcurrentHashMap<>()));

            while (System.currentTimeMillis() - start < timeoutMs) {
                final double[] px = {0}, py = {0}, pz = {0};
                client.execute(() -> { if (player != null) { px[0] = player.getX(); py[0] = player.getY(); pz[0] = player.getZ(); } });
                try { Thread.sleep(30); } catch (InterruptedException e) { break; }

                double dx = tx - px[0];
                double dy = ty - py[0];
                double dz = tz - pz[0];
                double dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                double horizontal = Math.sqrt(dx * dx + dz * dz);

                if (dist <= Math.max(reachDistance, 1.5)) {
                    client.execute(() -> KeyController.stopAll(client, new java.util.concurrent.ConcurrentHashMap<>()));
                    Map<String, Object> verifier = new HashMap<>();
                    verifier.put("position", Map.of("x", Math.round(px[0]), "y", Math.round(py[0]), "z", Math.round(pz[0])));
                    verifier.put("remainingDistance", dist);
                    future.complete(new McApiActionResult(true, "moved to target", Map.of(), verifier));
                    return;
                }

                double moved = Math.sqrt(Math.pow(px[0] - lastX[0], 2) + Math.pow(pz[0] - lastZ[0], 2));
                double verticalMove = py[0] - lastY[0];
                boolean isStuck = moved < 0.15 && verticalMove < 0.2;

                final float yaw = (float) (Math.atan2(dz, dx) * 180.0 / Math.PI - 90.0);
                final float pitch = (float) (-Math.atan2(dy, horizontal) * 180.0 / Math.PI);

                if (isStuck) {
                    if (stuckStart[0] == 0) {
                        stuckStart[0] = System.currentTimeMillis();
                        phaseStart[0] = System.currentTimeMillis();
                        stuckPhase[0] = 1;
                    }

                    long phaseFor = System.currentTimeMillis() - phaseStart[0];

                    if (stuckPhase[0] == 1 && phaseFor > 1500) {
                        stuckPhase[0] = 2;
                        phaseStart[0] = System.currentTimeMillis();
                        client.execute(() -> KeyController.stopAll(client, new java.util.concurrent.ConcurrentHashMap<>()));
                    } else if (stuckPhase[0] == 2 && phaseFor > 1200) {
                        stuckPhase[0] = 3;
                        phaseStart[0] = System.currentTimeMillis();
                        client.execute(() -> KeyController.stopAll(client, new java.util.concurrent.ConcurrentHashMap<>()));
                    } else if (stuckPhase[0] == 3 && phaseFor > 1200) {
                        client.execute(() -> KeyController.stopAll(client, new java.util.concurrent.ConcurrentHashMap<>()));
                        future.complete(new McApiActionResult(false, "stuck on obstacle", Map.of(), Map.of("remainingDistance", dist, "stuckPhase", stuckPhase[0])));
                        return;
                    }

                    client.execute(() -> {
                        player.setYaw(yaw);
                        player.setPitch(pitch);
                        switch (stuckPhase[0]) {
                            case 1:
                                client.options.jumpKey.setPressed(true);
                                client.options.forwardKey.setPressed(true);
                                break;
                            case 2:
                                client.options.forwardKey.setPressed(true);
                                client.options.leftKey.setPressed(true);
                                break;
                            case 3:
                                client.options.forwardKey.setPressed(true);
                                client.options.rightKey.setPressed(true);
                                break;
                        }
                    });
                    try { Thread.sleep(150); } catch (InterruptedException e) { break; }
                    continue;
                } else {
                    stuckStart[0] = 0;
                    stuckPhase[0] = 0;
                    phaseStart[0] = 0;
                }
                lastX[0] = px[0];
                lastZ[0] = pz[0];
                lastY[0] = py[0];

                client.execute(() -> {
                    player.setYaw(yaw);
                    player.setPitch(pitch);
                    client.options.forwardKey.setPressed(true);
                    if (dy > 0.5 && horizontal < 5) client.options.jumpKey.setPressed(true);
                    if (horizontal > 8) client.options.sprintKey.setPressed(true);
                });

                try { Thread.sleep(100); } catch (InterruptedException e) { break; }
            }

            client.execute(() -> KeyController.stopAll(client, new java.util.concurrent.ConcurrentHashMap<>()));
            Map<String, Object> verifier = new HashMap<>();
            verifier.put("timeout", true);
            future.complete(new McApiActionResult(false, "move_to timeout", Map.of(), verifier));
        }, "mc-api-move").start();
        return future;
    }

    public static CompletableFuture<McApiActionResult> useItem(long holdMs) {
        CompletableFuture<McApiActionResult> future = new CompletableFuture<>();
        new Thread(() -> {
            MinecraftClient client = MinecraftClient.getInstance();
            if (client == null || client.player == null) {
                future.complete(new McApiActionResult(false, "not in game", Map.of(), Map.of()));
                return;
            }
            client.execute(() -> client.options.useKey.setPressed(true));
            try { Thread.sleep(holdMs); } catch (InterruptedException ignored) {}
            client.execute(() -> client.options.useKey.setPressed(false));
            future.complete(new McApiActionResult(true, "used item", Map.of(), Map.of()));
        }, "mc-api-use").start();
        return future;
    }

    public static CompletableFuture<McApiActionResult> placeBlock(double tx, double ty, double tz) {
        CompletableFuture<McApiActionResult> future = new CompletableFuture<>();
        new Thread(() -> {
            MinecraftClient client = MinecraftClient.getInstance();
            if (client == null || client.player == null) {
                future.complete(new McApiActionResult(false, "not in game", Map.of(), Map.of()));
                return;
            }
            PlayerEntity player = client.player;
            client.execute(() -> {
                double dx = tx - player.getX();
                double dy = ty - player.getY();
                double dz = tz - player.getZ();
                double h = Math.sqrt(dx * dx + dz * dz);
                player.setYaw((float) (Math.atan2(dz, dx) * 180.0 / Math.PI - 90.0));
                player.setPitch((float) (-Math.atan2(dy, h) * 180.0 / Math.PI));
                client.options.useKey.setPressed(true);
            });
            try { Thread.sleep(300); } catch (InterruptedException ignored) {}
            client.execute(() -> client.options.useKey.setPressed(false));
            future.complete(new McApiActionResult(true, "placed block", Map.of(), Map.of()));
        }, "mc-api-place").start();
        return future;
    }

    public static Map<String, Object> inventorySummary(MinecraftClient client) {
        Map<String, Object> summary = new HashMap<>();
        if (client.player == null) return summary;

        Map<String, Integer> counts = new HashMap<>();
        List<Map<String, Object>> slots = new ArrayList<>();
        for (int i = 0; i < client.player.getInventory().size(); i++) {
            ItemStack stack = client.player.getInventory().getStack(i);
            if (stack.isEmpty()) continue;
            String id = Registries.ITEM.getId(stack.getItem()).toString();
            counts.merge(id, stack.getCount(), Integer::sum);
            if (i < 9) {
                slots.add(Map.of("slot", i, "id", id, "name", stack.getName().getString(), "count", stack.getCount()));
            }
        }
        summary.put("counts", counts);
        summary.put("hotbar", slots);
        summary.put("selectedSlot", client.player.getInventory().selectedSlot);
        return summary;
    }

    public static CompletableFuture<McApiActionResult> selectItem(String name) {
        CompletableFuture<McApiActionResult> future = new CompletableFuture<>();
        new Thread(() -> {
            MinecraftClient client = MinecraftClient.getInstance();
            if (client == null || client.player == null) {
                future.complete(new McApiActionResult(false, "not in game", Map.of(), Map.of()));
                return;
            }
            PlayerEntity player = client.player;
            String target = name.toLowerCase();

            for (int i = 0; i < 9; i++) {
                ItemStack stack = player.getInventory().getStack(i);
                if (stack.isEmpty()) continue;
                String id = Registries.ITEM.getId(stack.getItem()).toString().toLowerCase();
                String displayName = stack.getName().getString().toLowerCase();
                if (id.contains(target) || displayName.contains(target)) {
                    final int slot = i;
                    client.execute(() -> player.getInventory().selectedSlot = slot);
                    try { Thread.sleep(50); } catch (InterruptedException ignored) {}
                    future.complete(new McApiActionResult(true, "selected item in hotbar: " + id, Map.of(), Map.of("slot", slot, "itemId", id)));
                    return;
                }
            }

            int invSize = player.getInventory().size();
            for (int i = 9; i < invSize; i++) {
                ItemStack stack = player.getInventory().getStack(i);
                if (stack.isEmpty()) continue;
                String id = Registries.ITEM.getId(stack.getItem()).toString().toLowerCase();
                String displayName = stack.getName().getString().toLowerCase();
                if (id.contains(target) || displayName.contains(target)) {
                    final int fromSlot = i;
                    final int toSlot = 36 + player.getInventory().selectedSlot;
                    client.execute(() -> {
                        if (client.interactionManager != null) {
                            client.interactionManager.clickSlot(
                                player.currentScreenHandler.syncId,
                                fromSlot, 0, SlotActionType.SWAP, player
                            );
                        }
                    });
                    try { Thread.sleep(100); } catch (InterruptedException ignored) {}
                    future.complete(new McApiActionResult(true, "moved item to hotbar: " + id, Map.of(), Map.of("slot", player.getInventory().selectedSlot, "itemId", id)));
                    return;
                }
            }
            future.complete(new McApiActionResult(false, "item not found: " + target, Map.of(), Map.of()));
        }, "mc-api-select").start();
        return future;
    }

    public static CompletableFuture<McApiActionResult> openContainer(double tx, double ty, double tz) {
        CompletableFuture<McApiActionResult> future = new CompletableFuture<>();
        new Thread(() -> {
            MinecraftClient client = MinecraftClient.getInstance();
            if (client == null || client.player == null) {
                future.complete(new McApiActionResult(false, "not in game", Map.of(), Map.of()));
                return;
            }
            PlayerEntity player = client.player;
            client.execute(() -> {
                double dx = tx - player.getX();
                double dy = ty - player.getY();
                double dz = tz - player.getZ();
                double h = Math.sqrt(dx * dx + dz * dz);
                player.setYaw((float) (Math.atan2(dz, dx) * 180.0 / Math.PI - 90.0));
                player.setPitch((float) (-Math.atan2(dy, h) * 180.0 / Math.PI));
            });
            try { Thread.sleep(100); } catch (InterruptedException ignored) {}
            client.execute(() -> client.options.useKey.setPressed(true));
            try { Thread.sleep(400); } catch (InterruptedException ignored) {}
            client.execute(() -> client.options.useKey.setPressed(false));
            try { Thread.sleep(300); } catch (InterruptedException ignored) {}

            final boolean[] hasContainer = {false};
            client.execute(() -> {
                hasContainer[0] = player.currentScreenHandler != null
                    && player.currentScreenHandler != player.playerScreenHandler;
            });
            try { Thread.sleep(50); } catch (InterruptedException ignored) {}
            future.complete(new McApiActionResult(hasContainer[0],
                hasContainer[0] ? "opened container" : "no container opened",
                Map.of(), Map.of("containerOpened", hasContainer[0])));
        }, "mc-api-open").start();
        return future;
    }

    public static Map<String, Object> containerItems(MinecraftClient client) {
        Map<String, Object> result = new HashMap<>();
        if (client.player == null || client.player.currentScreenHandler == null) {
            result.put("open", false);
            return result;
        }
        ScreenHandler handler = client.player.currentScreenHandler;
        if (handler == client.player.playerScreenHandler) {
            result.put("open", false);
            return result;
        }

        List<Map<String, Object>> items = new ArrayList<>();
        int playerInvStart = handler.slots.size() > 36 ? handler.slots.size() - 36 : 0;
        for (int i = 0; i < playerInvStart; i++) {
            ItemStack stack = handler.getSlot(i).getStack();
            if (stack.isEmpty()) continue;
            items.add(Map.of(
                "slot", i,
                "id", Registries.ITEM.getId(stack.getItem()).toString(),
                "name", stack.getName().getString(),
                "count", stack.getCount()
            ));
        }
        result.put("open", true);
        result.put("type", handler.getClass().getSimpleName());
        result.put("containerItems", items);
        return result;
    }

    public static CompletableFuture<McApiActionResult> moveContainerItem(int fromSlot, int toSlot) {
        CompletableFuture<McApiActionResult> future = new CompletableFuture<>();
        MinecraftClient client = MinecraftClient.getInstance();
        if (client == null || client.player == null || client.interactionManager == null) {
            future.complete(new McApiActionResult(false, "not in game", Map.of(), Map.of()));
            return future;
        }
        PlayerEntity player = client.player;
        new Thread(() -> {
            client.execute(() -> {
                if (player.currentScreenHandler != null) {
                    client.interactionManager.clickSlot(
                        player.currentScreenHandler.syncId,
                        fromSlot, 0, SlotActionType.PICKUP, player
                    );
                }
            });
            try { Thread.sleep(80); } catch (InterruptedException ignored) {}
            client.execute(() -> {
                if (player.currentScreenHandler != null) {
                    client.interactionManager.clickSlot(
                        player.currentScreenHandler.syncId,
                        toSlot, 0, SlotActionType.PICKUP, player
                    );
                }
            });
            try { Thread.sleep(80); } catch (InterruptedException ignored) {}
            future.complete(new McApiActionResult(true, "moved item",
                Map.of(), Map.of("from", fromSlot, "to", toSlot)));
        }, "mc-api-moveitem").start();
        return future;
    }

    public static CompletableFuture<McApiActionResult> closeContainer() {
        CompletableFuture<McApiActionResult> future = new CompletableFuture<>();
        MinecraftClient client = MinecraftClient.getInstance();
        if (client == null || client.player == null) {
            future.complete(new McApiActionResult(false, "not in game", Map.of(), Map.of()));
            return future;
        }
        client.execute(() -> {
            if (client.player != null) {
                client.player.closeHandledScreen();
            }
        });
        future.complete(new McApiActionResult(true, "closed container", Map.of(), Map.of()));
        return future;
    }

    public static Map<String, Object> worldTime(MinecraftClient client) {
        Map<String, Object> result = new HashMap<>();
        if (client.world == null) return result;
        long timeOfDay = client.world.getTimeOfDay() % 24000;
        result.put("timeOfDay", timeOfDay);
        result.put("ticks", client.world.getTime());
        result.put("moonPhase", client.world.getMoonPhase());
        result.put("raining", client.world.isRaining());
        result.put("thundering", client.world.isThundering());
        result.put("difficulty", client.world.getDifficulty().getName());
        return result;
    }

    public static CompletableFuture<McApiActionResult> craftItem(String itemId, boolean makeAll) {
        CompletableFuture<McApiActionResult> future = new CompletableFuture<>();
        new Thread(() -> {
            MinecraftClient client = MinecraftClient.getInstance();
            if (client == null || client.player == null || client.world == null) {
                future.complete(new McApiActionResult(false, "not in game", Map.of(), Map.of()));
                return;
            }
            PlayerEntity player = client.player;
            String target = itemId.toLowerCase();

            final Map<String, Integer>[] beforeInv = new Map[]{new HashMap<>()};
            client.execute(() -> { beforeInv[0] = inventorySnapshot(client); });
            try { Thread.sleep(80); } catch (InterruptedException ignored) {}

            // Open inventory
            client.execute(() -> client.options.inventoryKey.setPressed(true));
            try { Thread.sleep(100); } catch (InterruptedException ignored) {}
            client.execute(() -> client.options.inventoryKey.setPressed(false));
            try { Thread.sleep(400); } catch (InterruptedException ignored) {}

            // Find material slot (e.g., oak_log slot) in player inventory and convert to screen handler slot
            // Player inv 0-8 (hotbar) -> screen 36-44, Player inv 9-35 -> screen 9-35
            int materialPlayerSlot = -1;
            if (target.contains("plank") || target.contains("stick")) {
                for (int i = 0; i < player.getInventory().size(); i++) {
                    ItemStack stack = player.getInventory().getStack(i);
                    if (stack.isEmpty()) continue;
                    String id = Registries.ITEM.getId(stack.getItem()).toString();
                    if (id.contains("log") || id.contains("plank")) { materialPlayerSlot = i; break; }
                }
            }

            if (materialPlayerSlot < 0) {
                client.execute(() -> client.options.inventoryKey.setPressed(true));
                try { Thread.sleep(50); } catch (InterruptedException ignored) {}
                client.execute(() -> client.options.inventoryKey.setPressed(false));
                future.complete(new McApiActionResult(false, "no material found for: " + itemId, Map.of(), Map.of()));
                return;
            }

            int screenSlot = materialPlayerSlot < 9 ? 36 + materialPlayerSlot : materialPlayerSlot;

            // Pick up the material
            client.execute(() -> {
                if (client.interactionManager != null && player.currentScreenHandler != null) {
                    client.interactionManager.clickSlot(
                        player.currentScreenHandler.syncId, screenSlot, 0,
                        net.minecraft.screen.slot.SlotActionType.PICKUP, player
                    );
                }
            });
            try { Thread.sleep(150); } catch (InterruptedException ignored) {}

            // Place in crafting grid (2x2: slots 1,2 top row; 3,4 bottom row)
            // For most recipes, place 1 in slot 1. For sticks, place 1 in slot 1 and 1 in slot 3.
            client.execute(() -> {
                if (client.interactionManager != null && player.currentScreenHandler != null) {
                    client.interactionManager.clickSlot(
                        player.currentScreenHandler.syncId, 1, 1,
                        net.minecraft.screen.slot.SlotActionType.PICKUP, player
                    );
                }
            });
            try { Thread.sleep(150); } catch (InterruptedException ignored) {}

            if (target.contains("stick")) {
                client.execute(() -> {
                    if (client.interactionManager != null && player.currentScreenHandler != null) {
                        client.interactionManager.clickSlot(
                            player.currentScreenHandler.syncId, 3, 1,
                            net.minecraft.screen.slot.SlotActionType.PICKUP, player
                        );
                    }
                });
                try { Thread.sleep(150); } catch (InterruptedException ignored) {}
            }

            // Return remaining to inventory
            client.execute(() -> {
                if (client.interactionManager != null && player.currentScreenHandler != null) {
                    client.interactionManager.clickSlot(
                        player.currentScreenHandler.syncId, screenSlot, 0,
                        net.minecraft.screen.slot.SlotActionType.PICKUP, player
                    );
                }
            });
            try { Thread.sleep(150); } catch (InterruptedException ignored) {}

            // Take output from slot 0
            client.execute(() -> {
                if (client.interactionManager != null && player.currentScreenHandler != null) {
                    client.interactionManager.clickSlot(
                        player.currentScreenHandler.syncId, 0, 0,
                        net.minecraft.screen.slot.SlotActionType.QUICK_MOVE, player
                    );
                }
            });
            try { Thread.sleep(200); } catch (InterruptedException ignored) {}

            // Close inventory
            client.execute(() -> client.options.inventoryKey.setPressed(true));
            try { Thread.sleep(50); } catch (InterruptedException ignored) {}
            client.execute(() -> client.options.inventoryKey.setPressed(false));
            try { Thread.sleep(200); } catch (InterruptedException ignored) {}

            final Map<String, Integer>[] afterInv = new Map[]{new HashMap<>()};
            client.execute(() -> { afterInv[0] = inventorySnapshot(client); });
            try { Thread.sleep(80); } catch (InterruptedException ignored) {}

            Map<String, Integer> delta = inventoryDelta(beforeInv[0], afterInv[0]);
            Map<String, Object> verifier = new HashMap<>();
            verifier.put("inventoryDelta", delta);

            if (!delta.isEmpty()) {
                future.complete(new McApiActionResult(true, "crafted " + itemId, delta, verifier));
            } else {
                future.complete(new McApiActionResult(false, "craft failed: no inventory change", delta, verifier));
            }
        }, "mc-api-craft").start();
        return future;
    }

    public static CompletableFuture<McApiActionResult> pathTo(double tx, double ty, double tz, long timeoutMs) {
        CompletableFuture<McApiActionResult> future = new CompletableFuture<>();
        new Thread(() -> {
            MinecraftClient client = MinecraftClient.getInstance();
            if (client == null || client.player == null) {
                future.complete(new McApiActionResult(false, "not in game", Map.of(), Map.of()));
                return;
            }
            try {
                client.execute(() -> {
                    var baritone = BaritoneAPI.getProvider().getPrimaryBaritone();
                    baritone.getCustomGoalProcess().setGoalAndPath(new GoalBlock((int) Math.round(tx), (int) Math.round(ty), (int) Math.round(tz)));
                });
                Thread.sleep(500);
                long start = System.currentTimeMillis();
                var baritone = BaritoneAPI.getProvider().getPrimaryBaritone();
                while (System.currentTimeMillis() - start < timeoutMs) {
                    final var posBox = new Object(){ double x, y, z; };
                    client.execute(() -> {
                        var pp = baritone.getPlayerContext().playerFeet();
                        posBox.x = pp.x;
                        posBox.y = pp.y;
                        posBox.z = pp.z;
                    });
                    Thread.sleep(100);
                    double dist = Math.sqrt(Math.pow(tx - posBox.x, 2) + Math.pow(ty - posBox.y, 2) + Math.pow(tz - posBox.z, 2));
                    if (dist <= 2.0) {
                        client.execute(() -> baritone.getPathingBehavior().cancelEverything());
                        Map<String, Object> verifier = new HashMap<>();
                        verifier.put("position", Map.of("x", posBox.x, "y", posBox.y, "z", posBox.z));
                        verifier.put("remainingDistance", dist);
                        future.complete(new McApiActionResult(true, "path reached target", Map.of(), verifier));
                        return;
                    }
                    Thread.sleep(400);
                }
                client.execute(() -> baritone.getPathingBehavior().cancelEverything());
                future.complete(new McApiActionResult(false, "path timeout", Map.of(), Map.of()));
            } catch (Exception e) {
                future.complete(new McApiActionResult(false, "path error: " + e.getMessage(), Map.of(), Map.of()));
            }
        }, "mc-api-path").start();
        return future;
    }
}
