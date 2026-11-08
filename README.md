# hob-pi

A [Pi](https://pi.dev) extension that runs Pi on the local models [Hob](https://hob.chat) has already downloaded. It needs no account or API key, and nothing leaves your machine.

Hob runs models with llama.cpp, and for its vision feature it downloads llama.cpp's own server, `llama-server`. That server speaks the OpenAI chat API, tool calls included. This extension registers Hob's models as a Pi provider and starts and stops `llama-server` for you.

## Features

- **Finds Hob automatically:** its data folder, its models (including a custom downloads drive set in Hob's setup) and its bundled `llama-server`.
- **Adds a `hob` provider to Pi:** every downloaded model shows up in `/model` and in `pi --list-models hob`.
- **Starts the server on demand:** the server starts on the first prompt to a Hob model and listens on `127.0.0.1` only. Pi's footer shows progress while the model loads.
- **Switches models:** picking another Hob model restarts the server with that model.
- **Cleans up:** quitting Pi stops any server the extension started.
- **Fits models to your GPU:** llama.cpp decides how many layers fit in GPU memory and keeps the rest on the CPU, so models larger than your VRAM still load.

## Requirements

- Pi 1.5 or later
- Hob, with at least one model downloaded and the vision feature's `llama-server` installed
- Linux, macOS or Windows (tested on Linux)

## Installation

Install the extension for every Pi session:

```sh
mkdir -p ~/.pi/agent/extensions
curl -fsSL -o ~/.pi/agent/extensions/hob.js \
  https://raw.githubusercontent.com/dowilcox/hob-pi/main/hob.js
```

Or clone the repository and load the extension for a single session:

```sh
git clone https://github.com/dowilcox/hob-pi.git
pi -e hob-pi/hob.js
```

## Usage

Start Pi with a Hob model:

```sh
pi --provider hob --model gemma-4-e4b_q4_0-it
```

Or pick any `hob/…` model with `/model` inside Pi. Model ids are the GGUF file names in lowercase, without the extension.

To make a Hob model the default, add it to `~/.pi/agent/settings.json`:

```json
{ "defaultProvider": "hob", "defaultModel": "gemma-4-e4b_q4_0-it" }
```

The first prompt of a session waits while the model loads. Large models can take a minute or two when the model file isn't already cached in memory.

### Commands

| Command | Description |
|---|---|
| `/hob` | Shows the Hob folder, the `llama-server` path, the server status and the available models |
| `/hob stop` | Stops the server this Pi started |

## Configuration

The extension reads these environment variables when Pi starts:

| Variable | Default | Description |
|---|---|---|
| `HOB_DIR` | Platform default¹ | Hob's data folder |
| `HOB_PI_PORT` | `8091` | Server port. To run different models at once, give each Pi session its own port. |
| `HOB_PI_CTX` | `32768` | Context size in tokens. A larger context uses more GPU memory. Pi's system prompt and tools take about 5–10K. |
| `HOB_PI_NGL` | unset | Number of layers to put on the GPU. Leave it unset to let llama.cpp fit the model to available memory. A fixed value turns fitting off, and a model that doesn't fit then fails to load. |
| `HOB_PI_DEVICE` | `Vulkan0`² | The GPU to use. Set it to `""` to let llama.cpp use every GPU. |
| `HOB_PI_ARGS` | — | Extra `llama-server` arguments, for example `--n-cpu-moe 20` |
| `HOB_PI_SERVER` | Hob's | Path to a different `llama-server` binary |

¹ `~/.config/Hob` on Linux, `~/Library/Application Support/Hob` on macOS, `%APPDATA%\Hob` on Windows.

² Not set on macOS. On machines with both an integrated and a discrete GPU, llama.cpp otherwise spreads the model across both, which is usually much slower than using the discrete GPU plus the CPU. To see which device is which, run `llama-server --list-devices`. If `Vulkan0` isn't your fastest GPU, set `HOB_PI_DEVICE` to the right one.

For example, to set a larger context:

```sh
export HOB_PI_CTX=65536        # bash, zsh
set -Ux HOB_PI_CTX 65536       # fish
```

The server's log is `hob-pi-<port>.log` in the system temp folder (`/tmp/hob-pi-8091.log` on Linux).

## Running the server manually

If you want to manage the server yourself, for example to share one server between several Pi sessions, you can skip the extension and set things up by hand.

1. Start Hob's `llama-server` on a model. The build folder name changes when Hob updates its server.

   ```sh
   D=~/.config/Hob/vision/server-b11433/llama-b11433
   LD_LIBRARY_PATH=$D $D/llama-server \
     -m ~/.config/Hob/models/gemma-4-E4B_q4_0-it.gguf \
     --host 127.0.0.1 --port 8091 --jinja -c 32768 --alias gemma-4-e4b
   ```

   `--jinja` turns on the model's chat template, which tool calling needs. The server is ready when `curl -s 127.0.0.1:8091/health` returns `ok`.

2. Add a provider to `~/.pi/agent/models.json`:

   ```json
   {
     "providers": {
       "hob": {
         "name": "Hob (llama.cpp)",
         "baseUrl": "http://127.0.0.1:8091/v1",
         "api": "openai-completions",
         "apiKey": "none",
         "models": [
           {
             "id": "gemma-4-e4b",
             "name": "Gemma 4 E4B (Hob)",
             "contextWindow": 32768,
             "maxTokens": 4096,
             "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
           }
         ]
       }
     }
   }
   ```

3. Run `pi --provider hob --model gemma-4-e4b`.

Don't run a manual server and the extension on the same port. The extension won't take over a server it didn't start, and it reports the conflict instead.

## Tested configuration

Tested on an ASUS ROG Zephyrus G14 (RTX 5070 Ti Laptop GPU with 12 GB, Radeon 890M) on Linux, with Pi 1.5.0 and Hob 0.2.6 (`llama-server` build b11433, Vulkan).

| Model | Size | Result |
|---|---|---|
| `gemma-4-e4b_q4_0-it` | 4.8 GB | Fits fully on the GPU; ~87 tokens/s. Handles simple tool use. |
| `gemma-4-26b_q4_0-it` | 13.4 GB | MoE (4B active), partly on the CPU; ~40 tokens/s |
| `qwen3.8-27b-ud-iq4_xs` | 13.3 GB | Dense, so slow when partly on the CPU |
| `qwen3.6-35b-a3b-ud-iq4_xs` | 16.5 GB | MoE (3B active); best at tool calling, but tight on 12 GB VRAM |

Pi also works inside Impulse with Impulse's Pi integration: tool calls, workspace context and confirmation prompts all behave as they do with cloud models.

## Troubleshooting

**"llama-server didn't start …"**
Check the server log. The usual cause is running out of GPU memory. Unset `HOB_PI_NGL` if you set it, lower `HOB_PI_CTX`, choose a smaller model, or close other GPU-heavy apps (including Hob itself).

**"Port 8091 already serves …"**
Another server is using the port, either one you started manually or another Pi session's. Stop it, or set `HOB_PI_PORT` to a different port.

**"Hob's llama-server wasn't found …"**
Enable Hob's vision feature so that Hob downloads its server, or point `HOB_PI_SERVER` to a `llama-server` binary of your own.

**Generation is slow on a machine with two GPUs**
Make sure `HOB_PI_DEVICE` names the discrete GPU (see `llama-server --list-devices`).

**The model ignores tools or rambles**
Small models often do. Try a larger model such as Gemma 4 26B or Qwen 3.6 35B-A3B.

**`pi -p` hangs when run from a script**
When stdin isn't a terminal, Pi waits for input on it. Redirect stdin: `pi -p "…" </dev/null`.

## License

[MIT](LICENSE)
