package com.example.mcapi;

import com.mojang.brigadier.arguments.BoolArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandManager;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.minecraft.text.Text;

public final class McApiCommands {
    private McApiCommands() {
    }

    public static void register() {
        var toggle = ClientCommandManager.literal("toggle")
                .then(ClientCommandManager.literal("http")
                        .then(ClientCommandManager.argument("enabled", BoolArgumentType.bool())
                                .executes(ctx -> {
                                    boolean enabled = BoolArgumentType.getBool(ctx, "enabled");
                                    McApiSettings.getInstance().setHttpEnabled(enabled);
                                    ctx.getSource().sendFeedback(Text.literal("mc-api httpEnabled=" + enabled));
                                    return 1;
                                })))
                .then(ClientCommandManager.literal("screenshot")
                        .then(ClientCommandManager.argument("enabled", BoolArgumentType.bool())
                                .executes(ctx -> {
                                    boolean enabled = BoolArgumentType.getBool(ctx, "enabled");
                                    McApiSettings.getInstance().setScreenshotEnabled(enabled);
                                    ctx.getSource().sendFeedback(Text.literal("mc-api screenshotEnabled=" + enabled));
                                    return 1;
                                })))
                .then(ClientCommandManager.literal("stream")
                        .then(ClientCommandManager.argument("enabled", BoolArgumentType.bool())
                                .executes(ctx -> {
                                    boolean enabled = BoolArgumentType.getBool(ctx, "enabled");
                                    McApiSettings.getInstance().setStreamEnabled(enabled);
                                    ctx.getSource().sendFeedback(Text.literal("mc-api streamEnabled=" + enabled));
                                    return 1;
                                })))
                .then(ClientCommandManager.literal("ws")
                        .then(ClientCommandManager.argument("enabled", BoolArgumentType.bool())
                                .executes(ctx -> {
                                    boolean enabled = BoolArgumentType.getBool(ctx, "enabled");
                                    McApiSettings.getInstance().setWsEnabled(enabled);
                                    ctx.getSource().sendFeedback(Text.literal("mc-api wsEnabled=" + enabled));
                                    return 1;
                                })));

        ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) -> dispatcher.register(
                ClientCommandManager.literal("mcapi")
                        .then(ClientCommandManager.literal("status")
                                .executes(ctx -> {
                                    var s = McApiSettings.getInstance().get();
                                    ctx.getSource().sendFeedback(Text.literal(String.format(
                                            "mc-api settings | http=%s screenshot=%s stream=%s ws=%s wsUrl=%s",
                                            s.httpEnabled, s.screenshotEnabled, s.streamEnabled, s.wsEnabled, s.wsUrl
                                    )));
                                    return 1;
                                }))
                        .then(toggle)
                        .then(ClientCommandManager.literal("setws")
                                .then(ClientCommandManager.argument("url", StringArgumentType.greedyString())
                                        .executes(ctx -> {
                                            String url = StringArgumentType.getString(ctx, "url");
                                            McApiSettings.getInstance().setWsUrl(url);
                                            ctx.getSource().sendFeedback(Text.literal("mc-api wsUrl=" + url));
                                            return 1;
                                        })))
        ));
    }
}
