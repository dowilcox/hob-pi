# Pi on Hob's local models

[Pi](https://pi.dev) (the `pi` coding agent, 1.5+) can run on the models [Hob](https://hob.chat) has already downloaded, with no account and nothing leaving the machine. Hob runs models with llama.cpp, and it downloads llama.cpp's own server (`llama-server`) for its vision feature. That server speaks the OpenAI chat API, including tool calls, which Pi can use as a custom provider.

Tested 8 Nov 2026 on this laptop (Zephyrus G14, RTX 5070 Ti 12 GB, Radeon 890M) with Pi 1.5.0, Hob 0.2.6's `llama-server` build 11433 (Vulkan), and Gemma 4 E4B. That included Pi inside Impulse with Impulse's Pi extension: tool calls, the merge question and turn states all worked.

## What Hob has here

| | Path |
|---|---|
| Hob's folder | `~/.config/Hob` (`settings.json` has `activeModelId`, and `downloadsDir` if setup put downloads on another drive) |
| Models | `~/.config/Hob/models/*.gguf` |
| llama.cpp server | `~/.config/Hob/vision/server-b11433/llama-b11433/llama-server` (its `.so` libraries sit beside it) |

The models, smallest first, as Pi lists them (`hob/<id>`):

| Pi model id | Size | Notes |
|---|---|---|
| `gemma-4-e4b_q4_0-it` | 4.8 GB | Fits on the RTX GPU with room to spare, ~87 tokens/s. Good enough for simple tool use. |
| `qwen3.8-27b-ud-iq4_xs` | 13.3 GB | Dense 27B: partly on the CPU here, so slow. |
| `gemma-4-26b_q4_0-it` | 13.4 GB | Hob's default. MoE (4B active): llama.cpp keeps part of it on the CPU, ~42 tokens/s. The first load can take a minute or two. |
| `qwen3.6-35b-a3b-ud-iq4_xs` | 16.5 GB | MoE (3B active), the strongest at tool calling, but tight on 12 GB VRAM + 30 GB RAM. Close games and other big apps first. |

Bigger models compete with anything else on the GPU (a game, Hob itself). `nvidia-smi` shows what's using it.

## The easy way: the `hob.js` extension

`~/hob-pi/hob.js` is a Pi extension that does all of the manual steps below by itself:

- finds Hob's folder, its models and its `llama-server` (it follows `downloadsDir`)
- registers them as Pi's `hob` provider, so they appear in `/model` and `pi --list-models hob`
- before a prompt to a Hob model, starts `llama-server` on that model (127.0.0.1 only, port 8091), waits until it's loaded, and shows "loading …" in Pi's footer meanwhile
- switching to another Hob model in `/model` restarts the server with it
- quitting Pi stops a server it started
- `/hob` shows what it found and whether the server is running; `/hob stop` stops it

Install it for every Pi:

```fish
mkdir -p ~/.pi/agent/extensions
cp ~/hob-pi/hob.js ~/.pi/agent/extensions/hob.js
```

(or try it once without installing: `pi -e ~/hob-pi/hob.js`). Then:

```fish
pi --provider hob --model gemma-4-e4b_q4_0-it
```

or pick a `hob/…` model with `/model` inside Pi. To make it the default, add it to `~/.pi/agent/settings.json`:

```json
{ "defaultProvider": "hob", "defaultModel": "gemma-4-e4b_q4_0-it" }
```

The first prompt after starting takes a few seconds longer while the model loads, longer for the big ones (they're read from disk).

### Settings

Environment variables, read when Pi starts:

| Variable | Default | |
|---|---|---|
| `HOB_DIR` | `~/.config/Hob` | Hob's folder (macOS: `~/Library/Application Support/Hob`) |
| `HOB_PI_PORT` | `8091` | The server's port. Use a different one per Pi if two Pis should run different models at once. |
| `HOB_PI_CTX` | `32768` | Context size in tokens. More costs GPU memory. Pi's system prompt and tools take ~5–10K. |
| `HOB_PI_NGL` | (unset) | Layers on the GPU. Unset, llama.cpp fits the model by itself: as many layers as fit on the GPU, the rest (a MoE model's experts first) on the CPU. A fixed number turns that off, so `99` makes a model bigger than 12 GB fail with `ErrorOutOfDeviceMemory`. |
| `HOB_PI_DEVICE` | `Vulkan0` | The GPU to use (the RTX here). `Vulkan1` is the 890M; `""` lets llama.cpp spread the model over both, which for Gemma 4 26B was 3x slower (14 vs 42 tokens/s). |
| `HOB_PI_ARGS` | | Extra `llama-server` arguments, e.g. `--n-cpu-moe 20` to keep a MoE model's experts on the CPU |
| `HOB_PI_SERVER` | Hob's | Another `llama-server` to use |

In fish: `set -Ux HOB_PI_CTX 65536`, for example.

`llama-server --list-devices` lists the GPUs. Here `Vulkan0` is the RTX 5070 Ti and `Vulkan1` is the 890M. The extension uses `Vulkan0`. The server's log is `/tmp/hob-pi-8091.log`.

## The manual way

What the extension automates, if you'd rather run the server yourself (for example to share one server between several Pis):

1. Start Hob's server on a model:

   ```fish
   set D ~/.config/Hob/vision/server-b11433/llama-b11433
   env LD_LIBRARY_PATH=$D $D/llama-server -m ~/.config/Hob/models/gemma-4-E4B_q4_0-it.gguf \
       --host 127.0.0.1 --port 8091 --jinja -ngl 99 -c 32768 --alias gemma-4-e4b
   ```

   `--jinja` turns on the model's chat template, which tool calling needs. Wait for `curl -s 127.0.0.1:8091/health` to say `ok`.

2. Tell Pi about it in `~/.pi/agent/models.json`:

   ```json
   {
     "providers": {
       "hob": {
         "name": "Hob (llama.cpp)",
         "baseUrl": "http://127.0.0.1:8091/v1",
         "api": "openai-completions",
         "apiKey": "none",
         "models": [
           { "id": "gemma-4-e4b", "name": "Gemma 4 E4B (Hob)", "contextWindow": 32768, "maxTokens": 4096,
             "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
         ]
       }
     }
   }
   ```

3. `pi --provider hob --model gemma-4-e4b`.

Don't use both ways at once on the same port: the extension won't touch a server it didn't start, and says so.

## In Impulse

Nothing extra is needed: Impulse's own Pi extension (Agent Integration ▸ Hooks ▸ Pi) works the same whatever model Pi uses. With Gemma 4 E4B, Pi called Impulse's tools (`impulse_list_tasks`), saw the other workspaces in its system prompt, and Impulse's merge question appeared in Pi's confirm dialog.

## Troubleshooting

- **`pi -p` hangs when run from a script:** it waits for input on stdin when stdin isn't a terminal. Add `</dev/null`.
- **"Port 8091 already serves …":** another server (a manual one, or another Pi's) is on the port. Stop it, or set `HOB_PI_PORT`.
- **"llama-server didn't start …":** read `/tmp/hob-pi-8091.log`. Usually out of GPU memory: unset `HOB_PI_NGL` if you set it, lower `HOB_PI_CTX`, pick a smaller model, or close what's on the GPU.
- **Hob updates its server:** the folder name changes (`server-b<build>`). The extension finds the new one by itself; for the manual way, update the path.
- **The model ignores tools or rambles:** small models do. Try `gemma-4-26b_q4_0-it` or `qwen3.6-35b-a3b-ud-iq4_xs` when the GPU is free.
- **Pi's sign-in for other providers:** this doesn't need one. `/login` is only needed for cloud providers.
