package com.example.mcapi;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import net.minecraft.client.MinecraftClient;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.item.ItemStack;
import net.minecraft.recipe.RecipeEntry;
import net.minecraft.screen.slot.SlotActionType;
import java.util.concurrent.Executors;

public final class LocalHttpApiServer {
    private static final LocalHttpApiServer INSTANCE = new LocalHttpApiServer();
    private static final Gson GSON = new Gson();
    private static final int PORT = 38888;

    private final Map<String, Boolean> keyStates = new ConcurrentHashMap<>();
    private volatile boolean started;

    private LocalHttpApiServer() {
    }

    public static LocalHttpApiServer getInstance() {
        return INSTANCE;
    }

    public synchronized void start() {
        if (started) return;

        try {
            HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", PORT), 0);
            server.createContext("/api/state", new StateHandler());
            server.createContext("/api/input", new InputHandler());
            server.createContext("/api/look", new LookHandler());
            server.createContext("/api/stop_all", new StopAllHandler());
            server.createContext("/api/hotbar", new HotbarHandler());
            server.createContext("/api/raycast", new RaycastHandler());
            server.createContext("/api/chat", new ChatHandler());
            server.createContext("/api/break_block", new BreakBlockHandler());
            server.createContext("/api/attack_entity", new AttackEntityHandler());
            server.createContext("/api/move_to", new MoveToHandler());
            server.createContext("/api/path_to", new PathToHandler());
            server.createContext("/api/use_item", new UseItemHandler());
            server.createContext("/api/place_block", new PlaceBlockHandler());
            server.createContext("/api/inventory/summary", new InventorySummaryHandler());
            server.createContext("/api/select_item", new SelectItemHandler());
            server.createContext("/api/container/open", new ContainerOpenHandler());
            server.createContext("/api/container/items", new ContainerItemsHandler());
            server.createContext("/api/container/move", new ContainerMoveHandler());
            server.createContext("/api/container/close", new ContainerCloseHandler());
            server.createContext("/api/world/time", new WorldTimeHandler());
            server.createContext("/api/screenshot", new ScreenshotHandler());
            server.createContext("/api/stream", new StreamHandler());
            server.createContext("/api/debug/capture", new CaptureDebugHandler());
            server.createContext("/api/chat/history", new ChatHistoryHandler());
            server.createContext("/api/inventory/click", new InventoryClickHandler());
            server.createContext("/api/craft/recipe", new CraftRecipeHandler());
            server.createContext("/api/craft", new CraftHandler());
            server.setExecutor(Executors.newCachedThreadPool());
            server.start();
            started = true;

            ScreenshotService.getInstance().start();
            System.out.println("[mc-api] HTTP API started at http://127.0.0.1:" + PORT);
        } catch (IOException e) {
            throw new RuntimeException("Failed to start mc-api server", e);
        }
    }

    private final class StateHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled by mod settings\"}");
                return;
            }
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            sendJson(exchange, 200, GSON.toJson(MinecraftSnapshot.capture(keyStates)));
        }
    }

    private final class InputHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled by mod settings\"}");
                return;
            }
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendCorsHeaders(exchange);
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }

            JsonObject body = GSON.fromJson(readBody(exchange.getRequestBody()), JsonObject.class);
            if (body == null || !body.has("key") || !body.has("pressed")) {
                sendJson(exchange, 400, "{\"error\":\"Expected JSON body with key and pressed\"}");
                return;
            }

            String key = body.get("key").getAsString();
            boolean pressed = body.get("pressed").getAsBoolean();

            MinecraftClient client = MinecraftClient.getInstance();
            client.execute(() -> KeyController.apply(client, keyStates, key, pressed));
            sendJson(exchange, 200, "{\"ok\":true}");
        }
    }

    private final class ScreenshotHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            var settings = McApiSettings.getInstance().get();
            if (!settings.httpEnabled || !settings.screenshotEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api screenshot is disabled by mod settings\"}");
                return;
            }
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }

            byte[] jpeg = ScreenshotService.getInstance().getLatestJpeg();
            if (jpeg.length == 0) {
                sendJson(exchange, 503, "{\"error\":\"No screenshot available yet - check /api/debug/capture\"}");
                return;
            }

            Headers headers = exchange.getResponseHeaders();
            headers.set("Content-Type", "image/jpeg");
            headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
            headers.set("Access-Control-Allow-Origin", "*");
            exchange.sendResponseHeaders(200, jpeg.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(jpeg);
            }
        }
    }

    private final class ChatHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled by mod settings\"}");
                return;
            }
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendCorsHeaders(exchange);
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }

            JsonObject body = GSON.fromJson(readBody(exchange.getRequestBody()), JsonObject.class);
            if (body == null || !body.has("message")) {
                sendJson(exchange, 400, "{\"error\":\"Expected JSON body with message\"}");
                return;
            }

            String message = body.get("message").getAsString();
            MinecraftClient client = MinecraftClient.getInstance();
            client.execute(() -> {
                if (client.player != null && message != null && !message.isBlank()) {
                    client.player.networkHandler.sendChatMessage(message);
                }
            });
            sendJson(exchange, 200, "{\"ok\":true}");
        }
    }

    private final class LookHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled by mod settings\"}");
                return;
            }
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendCorsHeaders(exchange);
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            JsonObject body = GSON.fromJson(readBody(exchange.getRequestBody()), JsonObject.class);
            if (body == null || !body.has("yaw") || !body.has("pitch")) {
                sendJson(exchange, 400, "{\"error\":\"Expected JSON body with yaw and pitch\"}");
                return;
            }
            float yaw = body.get("yaw").getAsFloat();
            float pitch = body.get("pitch").getAsFloat();
            MinecraftClient client = MinecraftClient.getInstance();
            client.execute(() -> KeyController.look(client, yaw, pitch));
            sendJson(exchange, 200, "{\"ok\":true}");
        }
    }

    private final class StopAllHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled by mod settings\"}");
                return;
            }
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendCorsHeaders(exchange);
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            MinecraftClient client = MinecraftClient.getInstance();
            client.execute(() -> KeyController.stopAll(client, keyStates));
            sendJson(exchange, 200, "{\"ok\":true}");
        }
    }

    private final class HotbarHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled by mod settings\"}");
                return;
            }
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendCorsHeaders(exchange);
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            JsonObject body = GSON.fromJson(readBody(exchange.getRequestBody()), JsonObject.class);
            if (body == null || !body.has("slot")) {
                sendJson(exchange, 400, "{\"error\":\"Expected JSON body with slot\"}");
                return;
            }
            int slot = body.get("slot").getAsInt();
            MinecraftClient client = MinecraftClient.getInstance();
            client.execute(() -> KeyController.selectHotbar(client, slot));
            sendJson(exchange, 200, "{\"ok\":true}");
        }
    }

    private final class RaycastHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled by mod settings\"}");
                return;
            }
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            MinecraftClient client = MinecraftClient.getInstance();
            if (client == null || client.crosshairTarget == null) {
                sendJson(exchange, 200, GSON.toJson(new RaycastSnapshot("none", null, 0, 0, 0, 0, true)));
                return;
            }
            var hit = client.crosshairTarget;
            String type = hit.getType().toString().toLowerCase();
            String name = null;
            if (type.equals("block") && hit instanceof net.minecraft.util.hit.BlockHitResult bhr) {
                var state = client.world != null ? client.world.getBlockState(bhr.getBlockPos()) : null;
                name = state != null ? net.minecraft.registry.Registries.BLOCK.getId(state.getBlock()).toString() : null;
            } else if (type.equals("entity") && hit instanceof net.minecraft.util.hit.EntityHitResult ehr) {
                name = ehr.getEntity().getName().getString();
            }
            sendJson(exchange, 200, GSON.toJson(new RaycastSnapshot(
                    type,
                    name,
                    hit.getPos().x,
                    hit.getPos().y,
                    hit.getPos().z,
                    client.player != null ? client.player.getPos().distanceTo(hit.getPos()) : 0,
                    hit.getType() == net.minecraft.util.hit.HitResult.Type.MISS
            )));
        }
    }

    private final class StreamHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            var settings = McApiSettings.getInstance().get();
            if (!settings.httpEnabled || !settings.streamEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api stream is disabled by mod settings\"}");
                return;
            }
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }

            Headers headers = exchange.getResponseHeaders();
            headers.set("Content-Type", "multipart/x-mixed-replace; boundary=frame");
            headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
            headers.set("Access-Control-Allow-Origin", "*");
            exchange.sendResponseHeaders(200, -1);

            OutputStream out = exchange.getResponseBody();
            StreamClientImpl client = new StreamClientImpl(out);
            ScreenshotService.getInstance().addClient(client);

            // Block until client disconnects
            try {
                while (!Thread.currentThread().isInterrupted()) {
                    if (client.isClosed()) break;
                    try {
                        Thread.sleep(1000);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            } finally {
                ScreenshotService.getInstance().removeClient(client);
                try { out.close(); } catch (IOException ignored) {}
            }
        }
    }

    
    private final class ChatHistoryHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled\"}");
                return;
            }
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            int count = 20;
            String query = exchange.getRequestURI().getQuery();
            if (query != null) {
                String[] params = query.split("&");
                for (String param : params) {
                    if (param.startsWith("count=")) {
                        try { count = Integer.parseInt(param.substring(6)); } catch (NumberFormatException ignored) {}
                    }
                }
            }
            sendJson(exchange, 200, GSON.toJson(ChatHistory.getInstance().getRecent(count)));
        }
    }

    private final class InventoryClickHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled\"}");
                return;
            }
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendCorsHeaders(exchange);
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            JsonObject body = GSON.fromJson(readBody(exchange.getRequestBody()), JsonObject.class);
            if (body == null || !body.has("slot")) {
                sendJson(exchange, 400, "{\"error\":\"Expected slot, button, action\"}");
                return;
            }
            int slot = body.get("slot").getAsInt();
            int button = body.has("button") ? body.get("button").getAsInt() : 0;
            String actionName = body.has("action") ? body.get("action").getAsString() : "PICKUP";
            SlotActionType action = SlotActionType.valueOf(actionName.toUpperCase());

            MinecraftClient client = MinecraftClient.getInstance();
            client.execute(() -> {
                if (client.player != null && client.interactionManager != null) {
                    client.interactionManager.clickSlot(
                        client.player.currentScreenHandler.syncId,
                        slot, button, action, client.player
                    );
                }
            });
            sendJson(exchange, 200, "{\"ok\":true}");
        }
    }

    private final class CraftRecipeHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled\"}");
                return;
            }
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendCorsHeaders(exchange);
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            JsonObject body = GSON.fromJson(readBody(exchange.getRequestBody()), JsonObject.class);
            if (body == null || !body.has("itemId")) {
                sendJson(exchange, 400, "{\"error\":\"Expected itemId\"}");
                return;
            }
            String itemId = body.get("itemId").getAsString();
            boolean makeAll = body.has("makeAll") && body.get("makeAll").getAsBoolean();

            MinecraftClient client = MinecraftClient.getInstance();
            client.execute(() -> {
                if (client.player == null || client.interactionManager == null || client.world == null) return;
                var rm = client.world.getRecipeManager();
                for (RecipeEntry<?> entry : rm.values()) {
                    ItemStack output = entry.value().getResult(client.world.getRegistryManager());
                    String outId = net.minecraft.registry.Registries.ITEM.getId(output.getItem()).toString();
                    String outName = output.getName().getString().toLowerCase();
                    if (outId.contains(itemId) || outName.contains(itemId.toLowerCase())) {
                        client.interactionManager.clickRecipe(
                            client.player.currentScreenHandler.syncId, entry, makeAll
                        );
                        break;
                    }
                }
            });
            sendJson(exchange, 200, "{\"ok\":true}");
        }
    }

    private final class CraftHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled\"}");
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            JsonObject body = GSON.fromJson(readBody(exchange.getRequestBody()), JsonObject.class);
            if (body == null || !body.has("itemId")) {
                sendJson(exchange, 400, "{\"error\":\"Expected itemId\"}");
                return;
            }
            String itemId = body.get("itemId").getAsString();
            boolean makeAll = body.has("makeAll") && body.get("makeAll").getAsBoolean();
            McApiActions.craftItem(itemId, makeAll).thenAccept(result -> {
                try { sendJson(exchange, 200, GSON.toJson(result)); } catch (IOException ignored) {}
            });
        }
    }

    private final class BreakBlockHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled\"}");
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            String bodyStr = readBody(exchange.getRequestBody());
            JsonObject body = bodyStr.isEmpty() ? new JsonObject() : GSON.fromJson(bodyStr, JsonObject.class);
            long timeout = body != null && body.has("timeoutMs") ? body.get("timeoutMs").getAsLong() : 8000L;
            Double x = body != null && body.has("x") ? body.get("x").getAsDouble() : null;
            Double y = body != null && body.has("y") ? body.get("y").getAsDouble() : null;
            Double z = body != null && body.has("z") ? body.get("z").getAsDouble() : null;

            McApiActions.breakBlock(x, y, z, timeout).thenAccept(result -> {
                try {
                    sendJson(exchange, 200, GSON.toJson(result));
                } catch (IOException ignored) {}
            });
        }
    }

    private final class AttackEntityHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled\"}");
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            JsonObject body = GSON.fromJson(readBody(exchange.getRequestBody()), JsonObject.class);
            if (body == null || !body.has("target")) {
                sendJson(exchange, 400, "{\"error\":\"Expected JSON body with target\"}");
                return;
            }
            String target = body.get("target").getAsString();
            long timeout = body.has("timeoutMs") ? body.get("timeoutMs").getAsLong() : 10000L;

            McApiActions.attackEntity(target, timeout).thenAccept(result -> {
                try {
                    sendJson(exchange, 200, GSON.toJson(result));
                } catch (IOException ignored) {}
            });
        }
    }

    private final class MoveToHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled\"}");
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            JsonObject body = GSON.fromJson(readBody(exchange.getRequestBody()), JsonObject.class);
            if (body == null || !body.has("x") || !body.has("y") || !body.has("z")) {
                sendJson(exchange, 400, "{\"error\":\"Expected x,y,z\"}");
                return;
            }
            double x = body.get("x").getAsDouble();
            double y = body.get("y").getAsDouble();
            double z = body.get("z").getAsDouble();
            double reach = body.has("reachDistance") ? body.get("reachDistance").getAsDouble() : 1.5;
            long timeout = body.has("timeoutMs") ? body.get("timeoutMs").getAsLong() : 20000L;
            McApiActions.moveTo(x, y, z, reach, timeout).thenAccept(result -> {
                try { sendJson(exchange, 200, GSON.toJson(result)); } catch (IOException ignored) {}
            });
        }
    }

    private final class PathToHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled\"}");
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            JsonObject body = GSON.fromJson(readBody(exchange.getRequestBody()), JsonObject.class);
            if (body == null || !body.has("x") || !body.has("y") || !body.has("z")) {
                sendJson(exchange, 400, "{\"error\":\"Expected x,y,z\"}");
                return;
            }
            double x = body.get("x").getAsDouble();
            double y = body.get("y").getAsDouble();
            double z = body.get("z").getAsDouble();
            long timeout = body.has("timeoutMs") ? body.get("timeoutMs").getAsLong() : 30000L;
            McApiActions.pathTo(x, y, z, timeout).thenAccept(result -> {
                try { sendJson(exchange, 200, GSON.toJson(result)); } catch (IOException ignored) {}
            });
        }
    }

    private final class UseItemHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled\"}");
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            long holdMs = 200;
            String bodyStr = readBody(exchange.getRequestBody());
            if (!bodyStr.isEmpty()) {
                JsonObject body = GSON.fromJson(bodyStr, JsonObject.class);
                if (body != null && body.has("holdMs")) holdMs = body.get("holdMs").getAsLong();
            }
            McApiActions.useItem(holdMs).thenAccept(result -> {
                try { sendJson(exchange, 200, GSON.toJson(result)); } catch (IOException ignored) {}
            });
        }
    }

    private final class PlaceBlockHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled\"}");
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            JsonObject body = GSON.fromJson(readBody(exchange.getRequestBody()), JsonObject.class);
            if (body == null || !body.has("x") || !body.has("y") || !body.has("z")) {
                sendJson(exchange, 400, "{\"error\":\"Expected x,y,z\"}");
                return;
            }
            double x = body.get("x").getAsDouble();
            double y = body.get("y").getAsDouble();
            double z = body.get("z").getAsDouble();
            McApiActions.placeBlock(x, y, z).thenAccept(result -> {
                try { sendJson(exchange, 200, GSON.toJson(result)); } catch (IOException ignored) {}
            });
        }
    }

    private final class InventorySummaryHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled\"}");
                return;
            }
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            MinecraftClient client = MinecraftClient.getInstance();
            Map<String, Object> summary = McApiActions.inventorySummary(client);
            sendJson(exchange, 200, GSON.toJson(summary));
        }
    }

    private final class WorldTimeHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled\"}");
                return;
            }
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            MinecraftClient client = MinecraftClient.getInstance();
            sendJson(exchange, 200, GSON.toJson(McApiActions.worldTime(client)));
        }
    }

    private final class SelectItemHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled\"}");
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            JsonObject body = GSON.fromJson(readBody(exchange.getRequestBody()), JsonObject.class);
            if (body == null || !body.has("name")) {
                sendJson(exchange, 400, "{\"error\":\"Expected name\"}");
                return;
            }
            String name = body.get("name").getAsString();
            McApiActions.selectItem(name).thenAccept(result -> {
                try { sendJson(exchange, 200, GSON.toJson(result)); } catch (IOException ignored) {}
            });
        }
    }

    private final class ContainerOpenHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled\"}");
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            JsonObject body = GSON.fromJson(readBody(exchange.getRequestBody()), JsonObject.class);
            if (body == null || !body.has("x") || !body.has("y") || !body.has("z")) {
                sendJson(exchange, 400, "{\"error\":\"Expected x,y,z\"}");
                return;
            }
            double x = body.get("x").getAsDouble();
            double y = body.get("y").getAsDouble();
            double z = body.get("z").getAsDouble();
            McApiActions.openContainer(x, y, z).thenAccept(result -> {
                try { sendJson(exchange, 200, GSON.toJson(result)); } catch (IOException ignored) {}
            });
        }
    }

    private final class ContainerItemsHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled\"}");
                return;
            }
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            MinecraftClient client = MinecraftClient.getInstance();
            sendJson(exchange, 200, GSON.toJson(McApiActions.containerItems(client)));
        }
    }

    private final class ContainerMoveHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled\"}");
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            JsonObject body = GSON.fromJson(readBody(exchange.getRequestBody()), JsonObject.class);
            if (body == null || !body.has("from") || !body.has("to")) {
                sendJson(exchange, 400, "{\"error\":\"Expected from, to\"}");
                return;
            }
            int from = body.get("from").getAsInt();
            int to = body.get("to").getAsInt();
            McApiActions.moveContainerItem(from, to).thenAccept(result -> {
                try { sendJson(exchange, 200, GSON.toJson(result)); } catch (IOException ignored) {}
            });
        }
    }

    private final class ContainerCloseHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled\"}");
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            McApiActions.closeContainer().thenAccept(result -> {
                try { sendJson(exchange, 200, GSON.toJson(result)); } catch (IOException ignored) {}
            });
        }
    }

    private static final class StreamClientImpl implements ScreenshotService.StreamClient {
        private static final byte[] HEADER_TEMPLATE = "Content-Type: image/jpeg\r\nContent-Length: ".getBytes(StandardCharsets.US_ASCII);
        private static final byte[] HEADER_END = "\r\n\r\n".getBytes(StandardCharsets.US_ASCII);
        private final OutputStream out;
        private volatile boolean closed;
        private boolean firstFrame = true;

        StreamClientImpl(OutputStream out) {
            this.out = out;
        }

        boolean isClosed() {
            return closed;
        }

        @Override
        public boolean write(byte[] jpeg) {
            if (closed) return false;
            try {
                if (firstFrame) {
                    out.write("--frame\r\n".getBytes(StandardCharsets.US_ASCII));
                    firstFrame = false;
                } else {
                    out.write("\r\n--frame\r\n".getBytes(StandardCharsets.US_ASCII));
                }
                out.write(HEADER_TEMPLATE);
                out.write(Long.toString(jpeg.length).getBytes(StandardCharsets.US_ASCII));
                out.write(HEADER_END);
                out.write(jpeg);
                out.flush();
                return true;
            } catch (IOException e) {
                closed = true;
                return false;
            }
        }

        @Override
        public void close() {
            closed = true;
        }
    }

    private static void sendJson(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        Headers headers = exchange.getResponseHeaders();
        headers.set("Content-Type", "application/json; charset=utf-8");
        setCorsHeaders(headers);
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    private static void sendCorsHeaders(HttpExchange exchange) {
        setCorsHeaders(exchange.getResponseHeaders());
    }

    private static void setCorsHeaders(Headers headers) {
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("Access-Control-Allow-Headers", "Content-Type");
        headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    }

    private final class CaptureDebugHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!McApiSettings.getInstance().get().httpEnabled) {
                sendJson(exchange, 503, "{\"error\":\"mc-api http is disabled by mod settings\"}");
                return;
            }
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            ScreenshotService.CaptureStatus status = ScreenshotService.getInstance().getStatus();
            sendJson(exchange, 200, GSON.toJson(status));
        }
    }

    private static String readBody(InputStream inputStream) throws IOException {
        return new String(inputStream.readAllBytes(), StandardCharsets.UTF_8);
    }
}
