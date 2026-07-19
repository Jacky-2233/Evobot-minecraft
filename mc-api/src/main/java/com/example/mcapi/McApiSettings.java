package com.example.mcapi;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

public final class McApiSettings {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final McApiSettings INSTANCE = new McApiSettings();

    private final Path configPath;
    private Data data;

    private McApiSettings() {
        this.configPath = FabricLoader.getInstance().getConfigDir().resolve("mc-api.json");
        this.data = load();
    }

    public static McApiSettings getInstance() {
        return INSTANCE;
    }

    public synchronized Data get() {
        return data;
    }

    public synchronized void setHttpEnabled(boolean enabled) {
        data.httpEnabled = enabled;
        save();
    }

    public synchronized void setScreenshotEnabled(boolean enabled) {
        data.screenshotEnabled = enabled;
        save();
    }

    public synchronized void setStreamEnabled(boolean enabled) {
        data.streamEnabled = enabled;
        save();
    }

    public synchronized void setWsEnabled(boolean enabled) {
        data.wsEnabled = enabled;
        save();
    }

    public synchronized void setWsUrl(String url) {
        data.wsUrl = url;
        save();
    }

    private Data load() {
        try {
            if (Files.exists(configPath)) {
                String text = Files.readString(configPath, StandardCharsets.UTF_8);
                Data parsed = GSON.fromJson(text, Data.class);
                if (parsed != null) return parsed;
            }
        } catch (Exception e) {
            System.err.println("[mc-api] Failed to load settings: " + e.getMessage());
        }
        Data defaults = new Data();
        save(defaults);
        return defaults;
    }

    private synchronized void save() {
        save(this.data);
    }

    private void save(Data toSave) {
        try {
            Files.createDirectories(configPath.getParent());
            Files.writeString(configPath, GSON.toJson(toSave), StandardCharsets.UTF_8);
        } catch (IOException e) {
            System.err.println("[mc-api] Failed to save settings: " + e.getMessage());
        }
    }

    public static final class Data {
        public boolean httpEnabled = true;
        public boolean screenshotEnabled = true;
        public boolean streamEnabled = true;
        public boolean wsEnabled = false;
        public String wsUrl = "ws://127.0.0.1:38999/ws";
    }
}
