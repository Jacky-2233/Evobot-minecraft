package com.example.mcapi;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.option.GameOptions;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import org.lwjgl.glfw.GLFW;

import java.util.Locale;
import java.util.Map;

public final class KeyController {
    private KeyController() {
    }

    public static void apply(MinecraftClient client, Map<String, Boolean> keyStates, String key, boolean pressed) {
        String normalized = key.toLowerCase(Locale.ROOT);

        long window = client.getWindow().getHandle();
        int action = pressed ? GLFW.GLFW_PRESS : GLFW.GLFW_RELEASE;

        // Mouse buttons: use KeyBinding directly
        if (normalized.endsWith("_mouse")) {
            if (client.options != null) {
                GameOptions options = client.options;
                KeyBinding binding = switch (normalized) {
                    case "left_mouse" -> options.attackKey;
                    case "right_mouse" -> options.useKey;
                    case "middle_mouse" -> options.pickItemKey;
                    default -> null;
                };
                if (binding != null) {
                    binding.setPressed(pressed);
                    if (pressed) {
                        KeyBinding.onKeyPressed(binding.getDefaultKey());
                    }
                }
            }
            keyStates.put(normalized, pressed);
            return;
        }

        // Keyboard keys: inject through the game's input handler
        Integer code = resolveKeyCode(normalized);
        if (code == null) return;

        client.keyboard.onKey(window, code, 0, action, 0);
        keyStates.put(normalized, pressed);
    }

    public static void stopAll(MinecraftClient client, Map<String, Boolean> keyStates) {
        for (String key : keyStates.keySet().toArray(new String[0])) {
            apply(client, keyStates, key, false);
        }
        if (client.options != null) {
            client.options.forwardKey.setPressed(false);
            client.options.backKey.setPressed(false);
            client.options.leftKey.setPressed(false);
            client.options.rightKey.setPressed(false);
            client.options.jumpKey.setPressed(false);
            client.options.sprintKey.setPressed(false);
            client.options.sneakKey.setPressed(false);
            client.options.attackKey.setPressed(false);
            client.options.useKey.setPressed(false);
        }
    }

    public static void selectHotbar(MinecraftClient client, int slot) {
        if (client.player == null) return;
        client.player.getInventory().selectedSlot = Math.max(0, Math.min(slot, 8));
    }

    public static void look(MinecraftClient client, float yaw, float pitch) {
        if (client.player == null) return;
        client.player.setYaw(yaw);
        client.player.setPitch(Math.max(-90.0f, Math.min(90.0f, pitch)));
        client.player.setHeadYaw(yaw);
    }

    private static Integer resolveKeyCode(String key) {
        if (key.length() == 1) {
            char ch = key.charAt(0);
            if (ch >= 'a' && ch <= 'z') {
                return GLFW.GLFW_KEY_A + (ch - 'a');
            }
            if (ch >= '0' && ch <= '9') {
                return GLFW.GLFW_KEY_0 + (ch - '0');
            }
        }

        if (key.startsWith("f") && key.length() <= 3) {
            try {
                int fn = Integer.parseInt(key.substring(1));
                if (fn >= 1 && fn <= 12) {
                    return GLFW.GLFW_KEY_F1 + (fn - 1);
                }
            } catch (NumberFormatException ignored) {
            }
        }

        if (key.startsWith("num_") && key.length() == 5) {
            char ch = key.charAt(4);
            if (ch >= '0' && ch <= '9') {
                return GLFW.GLFW_KEY_KP_0 + (ch - '0');
            }
        }

        return switch (key) {
            case "space" -> GLFW.GLFW_KEY_SPACE;
            case "enter" -> GLFW.GLFW_KEY_ENTER;
            case "tab" -> GLFW.GLFW_KEY_TAB;
            case "escape" -> GLFW.GLFW_KEY_ESCAPE;
            case "backspace" -> GLFW.GLFW_KEY_BACKSPACE;
            case "insert" -> GLFW.GLFW_KEY_INSERT;
            case "delete" -> GLFW.GLFW_KEY_DELETE;
            case "home" -> GLFW.GLFW_KEY_HOME;
            case "end" -> GLFW.GLFW_KEY_END;
            case "pageup" -> GLFW.GLFW_KEY_PAGE_UP;
            case "pagedown" -> GLFW.GLFW_KEY_PAGE_DOWN;
            case "up" -> GLFW.GLFW_KEY_UP;
            case "down" -> GLFW.GLFW_KEY_DOWN;
            case "left" -> GLFW.GLFW_KEY_LEFT;
            case "right" -> GLFW.GLFW_KEY_RIGHT;
            case "shift", "lshift" -> GLFW.GLFW_KEY_LEFT_SHIFT;
            case "rshift" -> GLFW.GLFW_KEY_RIGHT_SHIFT;
            case "ctrl", "lctrl" -> GLFW.GLFW_KEY_LEFT_CONTROL;
            case "rctrl" -> GLFW.GLFW_KEY_RIGHT_CONTROL;
            case "alt", "lalt" -> GLFW.GLFW_KEY_LEFT_ALT;
            case "ralt" -> GLFW.GLFW_KEY_RIGHT_ALT;
            case "caps_lock" -> GLFW.GLFW_KEY_CAPS_LOCK;
            case "num_lock" -> GLFW.GLFW_KEY_NUM_LOCK;
            case "scroll_lock" -> GLFW.GLFW_KEY_SCROLL_LOCK;
            case "print_screen" -> GLFW.GLFW_KEY_PRINT_SCREEN;
            case "pause" -> GLFW.GLFW_KEY_PAUSE;
            case "menu" -> GLFW.GLFW_KEY_MENU;
            case "minus" -> GLFW.GLFW_KEY_MINUS;
            case "equals" -> GLFW.GLFW_KEY_EQUAL;
            case "left_bracket" -> GLFW.GLFW_KEY_LEFT_BRACKET;
            case "right_bracket" -> GLFW.GLFW_KEY_RIGHT_BRACKET;
            case "semicolon" -> GLFW.GLFW_KEY_SEMICOLON;
            case "apostrophe" -> GLFW.GLFW_KEY_APOSTROPHE;
            case "comma" -> GLFW.GLFW_KEY_COMMA;
            case "period" -> GLFW.GLFW_KEY_PERIOD;
            case "slash" -> GLFW.GLFW_KEY_SLASH;
            case "backslash" -> GLFW.GLFW_KEY_BACKSLASH;
            case "grave" -> GLFW.GLFW_KEY_GRAVE_ACCENT;
            case "num_add" -> GLFW.GLFW_KEY_KP_ADD;
            case "num_subtract" -> GLFW.GLFW_KEY_KP_SUBTRACT;
            case "num_multiply" -> GLFW.GLFW_KEY_KP_MULTIPLY;
            case "num_divide" -> GLFW.GLFW_KEY_KP_DIVIDE;
            case "num_decimal" -> GLFW.GLFW_KEY_KP_DECIMAL;
            case "num_enter" -> GLFW.GLFW_KEY_KP_ENTER;
            default -> null;
        };
    }
}
