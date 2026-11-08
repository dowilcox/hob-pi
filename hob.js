// Pi extension: use the models Hob has downloaded, through Hob's own
// llama.cpp server, as Pi's "hob" provider.
//
// It finds Hob's folder (~/.config/Hob on Linux, ~/Library/Application
// Support/Hob on macOS, %APPDATA%\Hob on Windows, or $HOB_DIR), lists every
// model in its models folder as hob/<file name>, and before a prompt to one
// of them starts llama-server (the one Hob downloaded for its vision model)
// on that model, on 127.0.0.1 only. Switching to another Hob model restarts
// the server with it; quitting Pi stops a server it started.
//
// Install: copy to ~/.pi/agent/extensions/hob.js (or load once with
// `pi -e ~/hob-pi/hob.js`). Then `/model` lists the Hob models, or start
// with `pi --provider hob --model <id>`. `/hob` shows what it found and
// whether the server is running; `/hob stop` stops it.
//
// Settings (environment variables):
//   HOB_DIR          Hob's folder, if not the usual one
//   HOB_PI_PORT      the server's port (8091)
//   HOB_PI_CTX       context size in tokens (32768)
//   HOB_PI_NGL       layers on the GPU (unset: llama.cpp fits the model itself)
//   HOB_PI_DEVICE    the GPU to use (Vulkan0; "" lets llama.cpp use all of them)
//   HOB_PI_ARGS      more llama-server arguments, e.g. "--n-cpu-moe 20"
//   HOB_PI_SERVER    a llama-server to use instead of Hob's

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, openSync } from "node:fs";
import { homedir, tmpdir, platform } from "node:os";
import { basename, dirname, join } from "node:path";

const PORT = Number(process.env.HOB_PI_PORT ?? 8091);
const CTX = Number(process.env.HOB_PI_CTX ?? 32768);
// Unset, llama.cpp fits the model itself (--fit): as many layers on the GPU
// as there's room for, the rest (a MoE model's experts first) on the CPU.
// A fixed number turns that off, so a model bigger than the GPU fails.
const NGL = process.env.HOB_PI_NGL;
// One GPU only: left to itself llama.cpp also spreads the model onto an
// integrated GPU, which on the G14 (RTX + 890M) is 3x slower than RTX + CPU.
// Hob's llama-server uses Vulkan, where Vulkan0 is the discrete GPU here.
const DEVICE = process.env.HOB_PI_DEVICE ?? "Vulkan0";
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = join(tmpdir(), `hob-pi-${PORT}.log`);

function hobDir() {
  if (process.env.HOB_DIR) return process.env.HOB_DIR;
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "Hob");
  if (platform() === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Hob");
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Hob");
}

// Where Hob keeps big files: its own folder, or the drive picked in setup.
function downloadsDir(dir) {
  try {
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    if (settings.downloadsDir) return settings.downloadsDir;
  } catch {}
  return dir;
}

function findModels(downloads) {
  const folder = join(downloads, "models");
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => f.endsWith(".gguf") && !f.startsWith("mmproj"))
    .map((f) => ({
      id: basename(f, ".gguf").toLowerCase(),
      file: join(folder, f),
      size: statSync(join(folder, f)).size,
    }))
    .sort((a, b) => a.size - b.size);
}

// llama-server as Hob downloads it: <downloads>/vision/server-<build>/…/llama-server.
function findServer(downloads) {
  if (process.env.HOB_PI_SERVER) return process.env.HOB_PI_SERVER;
  const exe = platform() === "win32" ? "llama-server.exe" : "llama-server";
  const search = (dir, depth) => {
    if (depth < 0 || !existsSync(dir)) return undefined;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name === exe) return path;
      if (entry.isDirectory()) {
        const found = search(path, depth - 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  return search(join(downloads, "vision"), 3);
}

const gib = (bytes) => `${(bytes / 2 ** 30).toFixed(1)} GB`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// The model the server on our port has loaded (its alias), or undefined.
async function loadedModel() {
  try {
    const response = await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return undefined;
    const body = await response.json();
    return body.data?.[0]?.id;
  } catch {
    return undefined;
  }
}

export default function (pi) {
  const dir = hobDir();
  const downloads = downloadsDir(dir);
  const models = findModels(downloads);
  const server = findServer(downloads);
  if (models.length === 0) return; // no Hob here: nothing to offer

  pi.registerProvider("hob", {
    name: "Hob (local)",
    baseUrl: `${BASE}/v1`,
    api: "openai-completions",
    apiKey: "none",
    models: models.map((m) => ({
      id: m.id,
      name: `${m.id} (Hob, ${gib(m.size)})`,
      input: ["text"],
      reasoning: false,
      contextWindow: CTX,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  });

  let child; // the server this Pi started
  let starting; // a start in progress, shared by concurrent callers

  const stop = () => {
    if (child && child.exitCode === null) child.kill();
    child = undefined;
  };
  process.on("exit", stop);

  async function ensure(id, ctx) {
    const model = models.find((m) => m.id === id);
    if (!model) return;
    if ((await loadedModel()) === id) return;
    if (starting) return starting;
    starting = (async () => {
      if (!server) {
        ctx?.ui.notify(`Hob's llama-server wasn't found under ${join(downloads, "vision")}; set HOB_PI_SERVER`, "error");
        return;
      }
      const running = await loadedModel();
      if (running && !child) {
        ctx?.ui.notify(`Port ${PORT} already serves ${running}, not started by this Pi; set HOB_PI_PORT to use another`, "error");
        return;
      }
      stop();
      ctx?.ui.setStatus("hob", `loading ${id}…`);
      const extra = (process.env.HOB_PI_ARGS ?? "").split(/\s+/).filter(Boolean);
      if (NGL) extra.unshift("-ngl", NGL);
      if (DEVICE && !extra.some((a) => a === "--device" || a === "-dev")) extra.unshift("--device", DEVICE);
      const out = openSync(LOG, "w");
      child = spawn(
        server,
        ["-m", model.file, "--alias", id, "--host", "127.0.0.1", "--port", String(PORT),
         "--jinja", "-c", String(CTX), ...extra],
        {
          stdio: ["ignore", out, out],
          // The shared libraries sit beside Hob's llama-server.
          env: { ...process.env, LD_LIBRARY_PATH: [dirname(server), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") },
        },
      );
      const started = Date.now();
      while (Date.now() - started < 300_000) {
        if (child.exitCode !== null) break;
        if ((await loadedModel()) === id) {
          ctx?.ui.setStatus("hob", undefined);
          return;
        }
        await sleep(500);
      }
      ctx?.ui.setStatus("hob", undefined);
      ctx?.ui.notify(`llama-server didn't start ${id}; see ${LOG}`, "error");
      stop();
    })().finally(() => (starting = undefined));
    return starting;
  }

  // Before every prompt to a Hob model, so `pi -p` works too.
  pi.on("before_agent_start", async (_event, ctx) => {
    if (ctx.model?.provider === "hob") await ensure(ctx.model.id, ctx);
  });
  // Load a model as soon as it's picked in /model.
  pi.on("model_select", async (event, ctx) => {
    if (event.model.provider === "hob") ensure(event.model.id, ctx);
  });
  pi.on("session_shutdown", async (event) => {
    if (event.reason === "quit") stop();
  });

  pi.registerCommand("hob", {
    description: "Hob's models and its llama-server: /hob, /hob stop",
    handler: async (args, ctx) => {
      if (args.trim() === "stop") {
        const had = Boolean(child);
        stop();
        ctx.ui.notify(had ? "Stopped Hob's llama-server" : "This Pi hasn't started a server", "info");
        return;
      }
      const loaded = await loadedModel();
      const lines = [
        `Hob folder: ${dir}`,
        `llama-server: ${server ?? "not found"}`,
        `Server on ${BASE}: ${loaded ? `running ${loaded}${child ? "" : " (not started by this Pi)"}` : "not running"}`,
        "Models:",
        ...models.map((m) => `  hob/${m.id}  ${gib(m.size)}`),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
