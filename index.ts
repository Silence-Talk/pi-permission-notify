/**
 * pi-permission-notify — bridge permission prompts to Telegram.
 *
 * Two modes (config setting `remoteApproval`, default false):
 *
 * 1. Notify-only (default): listens to `permissions:ui_prompt` and sends a
 *    text notification. You approve/deny in the pi TUI.
 *
 * 2. Remote-approval (opt-in): hooks `tool_call` for bash, sends a Telegram
 *    message with Accept/Deny buttons, resolves on tap. When enabled, set
 *    the permission system's bash rules to `allow` to avoid double-prompting.
 *
 * Config: ~/.pi/agent/extensions/pi-permission-notify/config.json
 *   { "remoteApproval": false }
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const PERMISSIONS_UI_PROMPT_CHANNEL = "permissions:ui_prompt";
const NS = "pipermissionnotify";
const APPROVAL_TIMEOUT_MS = 120_000;

// ── Config ──────────────────────────────────────────────────────────────
interface ExtConfig { remoteApproval: boolean }
const CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", "pi-permission-notify", "config.json");
const CONFIG_DIR = join(homedir(), ".pi", "agent", "extensions", "pi-permission-notify");

function loadConfig(): ExtConfig {
  try {
    return { remoteApproval: !!JSON.parse(readFileSync(CONFIG_PATH, "utf8")).remoteApproval };
  } catch { return { remoteApproval: false } }
}

function saveConfig(remoteApproval: boolean): void {
  try { mkdirSync(CONFIG_DIR, { recursive: true }); } catch {}
  try { writeFileSync(CONFIG_PATH, JSON.stringify({ remoteApproval }, null, 2) + "\n", "utf8"); } catch {}
}

// ── Module resolution for @llblab/pi-telegram ──────────────────────────
async function loadMod(subpath: string): Promise<any | null> {
  try { return await import(`@llblab/pi-telegram/${subpath}`); } catch {}
  const roots = [join(homedir(), ".pi", "agent", "npm", "node_modules"), join(homedir(), ".pi", "agent", "node_modules")];
  for (const root of roots) {
    try {
      const req = createRequire(pathToFileURL(join(root, "__a.js")).href);
      return await import(pathToFileURL(req.resolve(`@llblab/pi-telegram/${subpath}`)).href);
    } catch {}
  }
  return null;
}

// ── Pending approval registry ──────────────────────────────────────────
interface Pending { resolve: (d: "allow" | "deny") => void; timer: ReturnType<typeof setTimeout>; handle?: any }
const pending = new Map<string, Pending>();
let counter = 0;
function shortId(): string { counter = (counter + 1) % 1_000_000; return String(counter); }

// ── Formatting ──────────────────────────────────────────────────────────
interface PromptEvt { surface: string | null; value: string | null; agentName: string | null; message: string; forwarding: { requesterAgentName: string | null } | null }
function fmtPrompt(e: PromptEvt): string {
  const s = e.surface ?? "operation"; const v = e.value ? `\n\n${"```"}\n${e.value}\n${"```"}` : "";
  const a = e.agentName ? ` (${e.agentName})` : ""; const sub = e.forwarding?.requesterAgentName ? ` — ${e.forwarding.requesterAgentName}` : "";
  return `⏳ Permission required${a}${sub}\n${s}${v}`;
}
function fmtBash(cmd: string): string { return `⏳ Approve command?\n${"```"}\n${cmd}\n${"```"}`; }

// ── Extension ──────────────────────────────────────────────────────────
export default function piPermissionNotifyExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  let delivery: any = null;
  // ── /permission-notify command: view/toggle remote-approval setting ─
  pi.registerCommand("permission-notify", {
    description: "Toggle pi-permission-notify remote-approval mode (on/off/status)",
    getArgumentCompletions: (prefix: string): any => {
      const opts = ["on", "off", "status"];
      const items = opts.map((o) => ({ value: o, label: o }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: any) => {
      const arg = (args ?? "").trim().toLowerCase();
      const current = loadConfig().remoteApproval;
      if (arg === "" || arg === "status") {
        ctx?.ui?.notify?.(
          `pi-permission-notify: remote-approval is ${current ? "ON (Telegram buttons)" : "OFF (notify-only)"}\nUsage: /permission-notify on|off|status  (restart pi to apply)`,
          "info",
        );
        return;
      }
      if (arg === "on" || arg === "enable" || arg === "true") {
        saveConfig(true);
        ctx?.ui?.notify?.(
          `pi-permission-notify: remote-approval ON ✓\nConfig saved — restart pi (or /reload) to apply.`,
          "info",
        );
        return;
      }
      if (arg === "off" || arg === "disable" || arg === "false") {
        saveConfig(false);
        ctx?.ui?.notify?.(
          `pi-permission-notify: remote-approval OFF ✓\nConfig saved — restart pi (or /reload) to apply.`,
          "info",
        );
        return;
      }
      ctx?.ui?.notify?.(
        `pi-permission-notify: unknown argument "${arg}".\nUsage: /permission-notify on|off|status`,
        "warn",
      );
    },
  });

  let updates: any = null;
  let handlerRegistered = false;

  async function ensure(): Promise<boolean> {
    if (!delivery) delivery = await loadMod("delivery");
    if (config.remoteApproval && !updates) {
      updates = await loadMod("updates");
      // Now that the updates module is loaded, register the callback handler.
      // This must happen AFTER updates is loaded, not at startup.
      if (updates) void registerHandler();
    }
    return !!delivery?.sendTelegramView;
  }

  async function send(view: any, opts: any): Promise<any | null> {
    if (!(await ensure())) return null;
    try {
      const r = await delivery.sendTelegramView(view, opts);
      if (r?.ok) return r.value;
      // Use partial handle if available (message was sent but response was partial)
      return r?.partial ?? null;
    } catch { return null; }
  }

  async function edit(handle: any, text: string): Promise<void> {
    if (!(await ensure()) || !delivery.editTelegramView) return;
    try { await delivery.editTelegramView(handle, { text, parseMode: "markdown" }); } catch {}
  }

  // Register the Telegram update handler once (for remote-approval callbacks).
  async function registerHandler() {
    if (handlerRegistered || !config.remoteApproval || !updates) return;
    if (typeof updates.registerTelegramUpdateHandler !== "function") return;
    handlerRegistered = true;
    updates.registerTelegramUpdateHandler(async (update: any) => {
      const cb = update?.callback_query; if (!cb?.data) return "pass";
      const parts = String(cb.data).split(":");
      if (parts[0] !== NS) return "pass";
      const action = parts[1]; const id = parts[2];
      const entry = pending.get(id);
      if (!entry) return "pass";
      clearTimeout(entry.timer);
      pending.delete(id);
      const decision = action === "approve" ? "allow" : "deny";
      // No public answerCallbackQuery export — the button spinner times out
      // after a few seconds. The message edit provides the real feedback.
      void edit(entry.handle, decision === "allow" ? "✅ Approved" : "❌ Denied");
      entry.resolve(decision);
      return "consume";
    });
  }

  // ── Mode 1: notify-only (default) — listen to permissions:ui_prompt ──
  // The permission system emits this on the raw event bus (pi.events), not
  // the public pi.on() API which only handles lifecycle events.
  const evtHandler = (data: unknown) => {
    const e = data as PromptEvt; if (!e || typeof e !== "object" || !e.message) return;
    void send({ text: fmtPrompt(e), parseMode: "markdown" }, { scope: { kind: "instance" } });
  };
  try { const bus: any = (pi as any).events; if (bus?.on) bus.on(PERMISSIONS_UI_PROMPT_CHANNEL, evtHandler); } catch {}

  // ── Mode 2: remote-approval (opt-in) — hook tool_call for bash ──────
  if (config.remoteApproval) {
    pi.on("tool_call" as any, async (event: any, ctx: any) => {
      // Only gate bash commands.
      if (event?.toolName !== "bash") return;
      const command: string = event?.input?.command;
      if (!command || typeof command !== "string") return;

      const id = shortId();
      let settled = false;

      // ── Surface 1: Telegram inline keyboard ──
      const tgHandle = await send(
        { text: fmtBash(command), parseMode: "markdown", replyMarkup: {
          inline_keyboard: [[
            { text: "✅ Approve", callback_data: `${NS}:approve:${id}` },
            { text: "❌ Deny", callback_data: `${NS}:deny:${id}` },
          ]]
        }},
        { scope: { kind: "instance" } },
      );

      const tgPromise = new Promise<"allow" | "deny" | null>((resolve) => {
        // null = no Telegram surface available (not connected / delivery failed)
        if (!tgHandle) return resolve(null);
        const timer = setTimeout(() => {
          if (settled) return;
          pending.delete(id);
          void edit(tgHandle, "⏱️ Timed out — denied");
          resolve("deny");
        }, APPROVAL_TIMEOUT_MS);
        pending.set(id, {
          resolve: (d) => { if (!settled) resolve(d); },
          timer, handle: tgHandle,
        });
      });

      // ── Surface 2: TUI confirm dialog ──
      // Shown in parallel so approval works even when Telegram isn't
      // connected yet (e.g. at bootup). Falls back gracefully if no UI.
      const tuiPromise: Promise<"allow" | "deny" | null> = (async () => {
        if (!ctx?.hasUI || typeof ctx?.ui?.confirm !== "function") return null;
        try {
          const ok = await ctx.ui.confirm("Bash approval required", command);
          return ok ? "allow" : "deny";
        } catch {
          return null; // dialog dismissed/cancelled — let Telegram decide
        }
      })();

      // ── Race: first surface to answer wins ──
      const decision = await new Promise<"allow" | "deny">((resolve) => {
        let done = false;
        const finish = (d: "allow" | "deny" | null) => {
          if (done || !d) return;
          done = true; settled = true;
          // Clean up the Telegram side if the TUI won.
          const entry = pending.get(id);
          if (entry) { clearTimeout(entry.timer); pending.delete(id); }
          // Edit the Telegram message to reflect the TUI decision.
          if (tgHandle) {
            void edit(tgHandle, d === "allow" ? "✅ Approved (TUI)" : "❌ Denied (TUI)");
          }
          resolve(d);
        };
        tgPromise.then(finish);
        tuiPromise.then(finish);
        // If both surfaces are unavailable (no Telegram + no UI), deny fail-closed.
        Promise.all([tgPromise, tuiPromise]).then(([tg, tui]) => {
          if (tg === null && tui === null && !done) {
            done = true; settled = true;
            resolve("deny");
          }
        });
      });

      if (decision === "deny") {
        return { block: true, reason: "Denied (Telegram/TUI approval)" };
      }
      // Allow — let the tool proceed.
    });
  }

  // ── session_start: confirm load + mode ───────────────────────────────
  pi.on("session_start", async (_e: any, ctx: any) => {
    const ok = await ensure();
    const mode = config.remoteApproval ? "remote-approval" : "notify-only";
    try {
      ctx?.ui?.notify?.(
        ok ? `pi-permission-notify: ${mode} mode active ✓`
           : `pi-permission-notify: ${mode} mode — delivery unavailable`,
        ok ? "info" : "warn",
      );
    } catch {}
  });
}
