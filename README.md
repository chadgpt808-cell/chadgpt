# OpenClaw Lite

**The same lobster, smaller shell.**

A minimal WhatsApp AI assistant designed for low-resource devices like the Alcatel 1C (1GB RAM, 8-16GB storage).

## What is this?

OpenClaw Lite is a stripped-down version of [OpenClaw](https://github.com/openclaw/openclaw) that:
- Runs on very limited hardware (Termux on cheap Android phones)
- Connects to WhatsApp via Baileys
- Uses Claude (Anthropic) for intelligence
- Maintains conversation history
- Supports custom personality via SOUL.md
- Includes a kiosk mode for dedicated devices

## Requirements

- Node.js 20+ (works with Termux on Android)
- Anthropic API key
- ~200MB RAM at runtime
- ~100MB disk space

## Quick Start

```bash
# Clone and install
git clone https://github.com/Hollando78/openclaw-lite
cd openclaw-lite
npm install

# Configure
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY

# Run
npm run dev

# Scan the QR code with WhatsApp
```

## Running on Termux (Android)

```bash
# Install Node.js in Termux
pkg update && pkg install nodejs-lts

# Clone and run
git clone https://github.com/Hollando78/openclaw-lite
cd openclaw-lite
npm install
npm run dev
```

## Configuration

Set these in your `.env` file or as environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | - | Your Anthropic API key |
| `OPENCLAW_MODEL` | No | `claude-sonnet-4-20250514` | Claude model to use |
| `OPENCLAW_MAX_TOKENS` | No | `4096` | Max tokens per response |
| `OPENCLAW_MAX_HISTORY` | No | `50` | Messages to keep in history |
| `OPENCLAW_ALLOW_LIST` | No | *(all)* | Comma-separated phone numbers |
| `OPENCLAW_OWNER` | No | - | Owner phone number for admin |
| `OPENCLAW_WORKSPACE_DIR` | No | `~/.openclaw-lite` | Directory for SOUL.md and config |
| `OPENCLAW_STATUS_PORT` | No | `8080` | Kiosk status server port |

## Custom Personality (SOUL.md)

Customize your bot's personality by creating a `SOUL.md` file:

```bash
# Copy the example
cp SOUL.example.md ~/.openclaw-lite/SOUL.md

# Edit to your liking
nano ~/.openclaw-lite/SOUL.md
```

The bot reloads SOUL.md every 60 seconds, so you can edit it without restarting.

Example SOUL.md:
```markdown
## Personality
- Friendly and helpful
- Speaks like a pirate
- Loves puns

## Tone
Keep it light and fun!
```

No SOUL.md? The bot uses a default lobster-themed personality.

## Kiosk Mode

OpenClaw Lite includes a built-in status server for running on dedicated devices.

1. Start the bot normally
2. Open `http://localhost:8080` in a browser
3. See live status: connection state, QR code, message counts, uptime

For a dedicated kiosk setup on Android:
1. Install [Fully Kiosk Browser](https://www.fully-kiosk.com/) (free version works)
2. Set it to load `http://localhost:8080`
3. Enable kiosk mode to lock the display

## Commands

Send these to the bot:

- `/help` - Show available commands
- `/clear` - Clear conversation history
- `/status` - Show bot status

## Memory Usage

Designed for 1GB RAM devices:
- Node.js baseline: ~50MB
- Baileys (WhatsApp): ~50-100MB
- Application: ~20MB
- **Total: ~150-200MB**

## Compared to Full OpenClaw

| Feature | OpenClaw | OpenClaw Lite |
|---------|----------|---------------|
| WhatsApp | Yes | Yes |
| Telegram | Yes | No |
| Discord | Yes | No |
| Other channels | Yes | No |
| Browser tools | Yes | No |
| Canvas | Yes | No |
| TTS | Yes | No |
| Skills/plugins | Yes | No |
| Gateway server | Yes | No |
| Conversation memory | Yes | Yes |
| Claude intelligence | Yes | Yes |
| Custom personality | Yes | Yes |
| Kiosk mode | No | Yes |
| RAM usage | 500-800MB | 150-200MB |
| Install size | 1.5GB+ | ~100MB |

## License

MIT - Same as OpenClaw
