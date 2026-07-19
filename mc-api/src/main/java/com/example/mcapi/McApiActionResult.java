package com.example.mcapi;

import java.util.Map;

public record McApiActionResult(
        boolean ok,
        String detail,
        Map<String, Integer> inventoryDelta,
        Map<String, Object> verifier
) {
}
