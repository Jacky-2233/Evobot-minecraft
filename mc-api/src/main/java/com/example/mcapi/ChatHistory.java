package com.example.mcapi;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class ChatHistory {
    private static final ChatHistory INSTANCE = new ChatHistory();
    private static final int MAX_MESSAGES = 50;
    private final List<ChatMessage> messages = new ArrayList<>();

    public static ChatHistory getInstance() { return INSTANCE; }

    public synchronized void add(String username, String message) {
        messages.add(new ChatMessage(username, message, System.currentTimeMillis()));
        if (messages.size() > MAX_MESSAGES) {
            messages.remove(0);
        }
    }

    public synchronized List<ChatMessage> getRecent(int count) {
        int from = Math.max(0, messages.size() - count);
        return Collections.unmodifiableList(new ArrayList<>(messages.subList(from, messages.size())));
    }

    public record ChatMessage(String username, String message, long timestamp) {}
}
