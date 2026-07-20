import fs from "fs";
import path from "path";
import readline from "readline";
import { EvoBotV8 } from "./core/bot.js";
import type { BotConfig } from "./types/index.js";

const CONFIG_PATH = path.join(process.cwd(), "config.json");

function loadConfig(): BotConfig {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    const ai = raw.ai || {};
    return {
        backend: "mc-api",
        host: raw.minecraft?.host ?? "127.0.0.1",
        port: raw.minecraft?.port ?? 25565,
        username: raw.minecraft?.username ?? "EvoBot",
        version: raw.minecraft?.version ?? "1.21.1",
        auth: raw.minecraft?.auth ?? "offline",
        updateIntervalMs: raw.bot?.updateInterval ?? 500,
        autoReconnect: raw.bot?.autoReconnect ?? true,
        hungerThreshold: raw.bot?.hungerThreshold ?? 16,
        lowHealthThreshold: raw.bot?.lowHealthThreshold ?? 8,
        criticalHealthThreshold: raw.bot?.criticalHealthThreshold ?? 4,
        stuckTimeoutMs: raw.bot?.stuckTimeoutMs ?? 30000,
        ai: {
            provider: ai.provider || "deepseek",
            model: ai.model || "deepseek-v4-flash",
            maxTokens: ai.maxTokens ?? 200,
            timeoutMs: ai.replyTimeout ?? 15000,
            providers: ai.providers || {},
            apiKey: ai.apiKey,
            baseURL: ai.baseURL,
        },
    };
}

function helpText(core: EvoBotV8): string {
    return [
        "EvoBot v8 Console (mc-api backend)",
        "",
        "Core:",
        "/help                         Show this help",
        "/status                       Full state summary",
        "/tasks                        Runtime task + queue",
        "/auto                         Toggle autonomous AI tick loop",
        "/stop                         Stop all current work",
        "/quit                         Exit process",
        "",
        "Actions:",
        "/say <msg>                    Send chat",
        "/move <x> <y> <z>             Move to coordinates",
        "/move_native <x> <y> <z>      Move via mc-api native controller",
        "/follow [player] [dist]       Follow a player (RuntimeTask)",
        "/search <target> [kind]       Search for entity/block (RuntimeTask)",
        "/collect <block> [count]      Break and collect blocks",
        "/make <item>                  Craft item (subgoal expansion)",
        "/craft <item>                 Quick craft via recipe",
        "/eat                          Eat food from inventory",
        "/retreat [dist]               Retreat from danger",
        "/tap <key>                    Tap a key",
        "/hold <key> <ms>              Hold a key",
        "/look <yaw> <pitch>           Set view angle",
        "/hotbar <0-8>                 Select hotbar slot",
        "/select <name>                Select item by name from inventory",
        "/time                         Show world time",
        "/inv                          Inventory summary",
        "",
        "Sensing:",
        "/scan [query]                 Nearby entities/blocks",
        "/players                      Player list",
        "/entities                     Nearby entities",
        "/blocks                       Nearby useful blocks",
        "/raycast                      Crosshair hit result",
        "/memory [query]               Search local RAG skill/examples/failures",
        "",
        "Model:",
        `/model [name]                 Switch model | ${core.getProvider()}/${core.getModel()}`,
    ].join("\n");
}

console.log("================================");
console.log("  EvoBot v8 - mc-api backend");
console.log("================================");

let core: EvoBotV8;
let autoMode = false;

async function main(): Promise<void> {
    core = new EvoBotV8(loadConfig());
    await core.start();

    if (!process.stdin.isTTY) return;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "/> " });

    const writeLog = (method: (...args: any[]) => void, args: any[]) => {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        method(...args);
        rl.prompt(true);
    };

    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origErr = console.error.bind(console);
    console.log = (...args: any[]) => writeLog(origLog, args);
    console.warn = (...args: any[]) => writeLog(origWarn, args);
    console.error = (...args: any[]) => writeLog(origErr, args);

    const parseCommand = (line: string): { cmd: string; args: string[] } => {
        const trimmed = line.trim();
        if (!trimmed) return { cmd: "", args: [] };
        const body = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
        const [cmd, ...args] = body.split(/\s+/);
        return { cmd: cmd.toLowerCase(), args };
    };

    rl.on("line", (line: string) => {
        const { cmd, args } = parseCommand(line);
        switch (cmd) {
            case "":
                break;
            case "help":
            case "?":
                console.log(helpText(core));
                break;

            // ── Core ──
            case "status":
                console.log(core.getStatusSummary());
                break;
            case "tasks":
                console.log(core.getTasksSummary());
                break;
            case "auto":
                autoMode = !autoMode;
                console.log(`Autonomous mode: ${autoMode ? "ON" : "OFF"}`);
                if (autoMode) {
                    console.log("AI will make decisions every few seconds. Use /stop or /auto to disable.");
                }
                break;
            case "stop":
                core.stopAll();
                autoMode = false;
                console.log("Stopped all work. Autonomous mode OFF.");
                break;

            // ── Actions ──
            case "say":
                void core.chat(args.join(" "));
                break;
            case "move":
                if (args.length < 3) console.log("Usage: /move <x> <y> <z>");
                else {
                    rl.pause();
                    core.moveTo(Number(args[0]) || 0, Number(args[1]) || 0, Number(args[2]) || 0, 2)
                        .then((r) => console.log(r.ok ? `Arrived: ${r.detail}` : `Failed: ${r.detail}`))
                        .catch((err: Error) => console.error("move error:", err.message))
                        .finally(() => { rl.resume(); rl.prompt(); });
                    return;
                }
                break;
            case "move_native":
                if (args.length < 3) console.log("Usage: /move_native <x> <y> <z>");
                else {
                    rl.pause();
                    core.moveToNative(Number(args[0]), Number(args[1]), Number(args[2]), 1.5, 20000)
                        .then((r: any) => console.log("move_native:", r.detail))
                        .finally(() => { rl.resume(); rl.prompt(); });
                    return;
                }
                break;
            case "use":
                rl.pause();
                core.useItemNative(Number(args[0]) || 200)
                    .then((r: any) => console.log("use:", r.detail))
                    .finally(() => { rl.resume(); rl.prompt(); });
                return;
            case "place":
                if (args.length < 3) console.log("Usage: /place <x> <y> <z>");
                else {
                    rl.pause();
                    core.placeBlockNative(Number(args[0]), Number(args[1]), Number(args[2]))
                        .then((r: any) => console.log("place:", r.detail))
                        .finally(() => { rl.resume(); rl.prompt(); });
                    return;
                }
                break;
            case "inv":
                rl.pause();
                core.inventorySummary()
                    .then((s: any) => console.log(JSON.stringify(s, null, 2)))
                    .finally(() => { rl.resume(); rl.prompt(); });
                return;
            case "select":
                if (!args[0]) console.log("Usage: /select <name>");
                else {
                    rl.pause();
                    core.selectItem(args.join(" "))
                        .then((r: any) => console.log(r.ok ? "Selected: " + r.detail : "Failed: " + r.detail))
                        .finally(() => { rl.resume(); rl.prompt(); });
                    return;
                }
                break;
            case "time":
                rl.pause();
                core.worldTime()
                    .then((t: any) => console.log(JSON.stringify(t, null, 2)))
                    .finally(() => { rl.resume(); rl.prompt(); });
                return;
            case "follow":
                core.followPlayer(args[0], Number(args[1]) || 12, Number(args[2]) || 2);
                console.log(`Following ${args[0] || "nearest player"}`);
                break;
            case "search":
                if (!args[0]) console.log("Usage: /search <target> [entity|block] [radius]");
                else {
                    const kind = (args[1] === "block" ? "block" : "entity") as "entity" | "block";
                    core.searchTarget(args[0], kind, Number(args[2]) || 24);
                    console.log(`Searching for ${args[0]} (${kind})`);
                }
                break;
            case "collect":
                if (!args[0]) console.log("Usage: /collect <block> [count]");
                else {
                    rl.pause();
                    core.queueTask("collect", { target: args[0], count: Number(args[1]) || 1 });
                    console.log(`Queued collect: ${args[0]} x${Number(args[1]) || 1}`);
                    rl.resume(); rl.prompt();
                    return;
                }
                break;
            case "make":
                if (!args[0]) {
                    console.log("Usage: /make <item>   (crafting_table, wooden_pickaxe, stone_pickaxe, furnace)");
                } else {
                    const item = args[0].toLowerCase();
                    core.queueTask("craft_recipe", { item });
                    console.log(`Queued craft subgoal plan: ${item}`);
                }
                break;
            case "craft":
                if (!args[0]) console.log("Usage: /craft <itemId> [makeAll]");
                else {
                    rl.pause();
                    core.craftRecipe(args[0], args[1] === "true" || args[1] === "all");
                    console.log(`Crafting ${args[0]}`);
                    rl.resume(); rl.prompt();
                    return;
                }
                break;
            case "eat":
                rl.pause();
                core.queueTask("eat", {});
                console.log("Queued eat");
                rl.resume(); rl.prompt();
                return;
            case "retreat":
                core.queueTask("retreat", { distance: Number(args[0]) || 16 });
                console.log(`Queued retreat ${Number(args[0]) || 16}m`);
                break;

            // ── Low-level control ──
            case "tap":
                if (!args[0]) console.log("Usage: /tap <key>");
                else void core.tap(args[0]);
                break;
            case "hold":
                if (!args[0] || !args[1]) console.log("Usage: /hold <key> <ms>");
                else void core.hold(args[0], Number(args[1]) || 250);
                break;
            case "look":
                if (args.length < 2) console.log("Usage: /look <yaw> <pitch>");
                else void core.look(Number(args[0]) || 0, Number(args[1]) || 0);
                break;
            case "hotbar":
                if (!args[0]) console.log("Usage: /hotbar <0-8>");
                else void core.selectHotbar(Number(args[0]) || 0);
                break;

            // ── Sensing ──
            case "raycast":
                rl.pause();
                core.getRaycastSummary()
                    .then((s: string) => console.log(s))
                    .finally(() => { rl.resume(); rl.prompt(); });
                return;
            case "memory":
                console.log(core.getMemorySummary(args.join(" ")));
                break;
            case "scan":
                console.log(core.getScanSummary(args.join(" "), 24));
                break;
            case "players":
                console.log(core.getPlayersSummary());
                break;
            case "entities":
                console.log(core.getEntitiesSummary(24, 12));
                break;
            case "blocks":
                console.log(core.getBlocksSummary(24, 12));
                break;
            case "model":
                if (!args[0]) {
                    console.log(`Current: ${core.getModel()} (${core.getProvider()})`);
                    console.log(`Available: ${core.listModels()}`);
                } else {
                    core.setModel(args[0]);
                }
                break;
            case "memory":
                console.log(core.getMemorySummary(args.join(" ")));
                break;
            case "web":
                if (!args[0]) { console.log("Usage: /web <query>"); }
                else {
                    rl.pause();
                    core.getWebKnowledgeSummary(args.join(" "))
                        .then((s: string) => console.log(s))
                        .catch((err: Error) => console.error("[WEB]", err.message))
                        .finally(() => { rl.resume(); rl.prompt(); });
                    return;
                }
                break;

            case "quit":
            case "exit":
                core.stop();
                process.exit(0);
                break;
            default:
                console.log(`Unknown: /${cmd}. Use /help`);
        }
        rl.prompt();
    });

    console.log(helpText(core));
    rl.prompt();
}

void main();
