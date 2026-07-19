package com.example.mcapi;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.fabricmc.fabric.api.client.rendering.v1.HudRenderCallback;
import net.minecraft.text.Text;

public class McApiClient implements ClientModInitializer {
    @Override
    public void onInitializeClient() {
        McApiSettings.getInstance();
        McApiCommands.register();
        LocalHttpApiServer.getInstance().start();
        HudRenderCallback.EVENT.register((drawContext, tickCounter) -> {
            ScreenshotService.getInstance().tryCapture();
        });

        // Register chat message listener
        ClientReceiveMessageEvents.CHAT.register((message, signedMessage, sender, params, receptionTimestamp) -> {
            String username = sender != null ? sender.getName() : "Server";
            String text = message != null ? message.getString() : "";
            ChatHistory.getInstance().add(username, text);
        });

        ClientReceiveMessageEvents.GAME.register((message, overlay) -> {
            if (!overlay) {
                String text = message != null ? message.getString() : "";
                ChatHistory.getInstance().add("[Game]", text);
            }
        });
    }
}
