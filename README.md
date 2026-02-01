# 🦞 OpenClaw Lite

**The same lobster, smaller shell.**

A minimal WhatsApp AI assistant designed for low-resource devices like the Alcatel 1C (1GB RAM, 8-16GB storage).

## What is this?

OpenClaw Lite is a stripped-down version of [OpenClaw](https://github.com/openclaw/openclaw) that:
- Runs on very limited hardware (Termux on cheap Android phones)
- Connects to WhatsApp via Baileys
- Uses Claude (Anthropic) for intelligence
- Maintains conversation history
- Has the same OpenClaw personality

## Requirements

- Node.js 20+ (works with Termux on Android)
- Anthropic API key
- ~200MB RAM at runtime
- ~100MB disk space

## Quick Start

```bash
# Clone and install
git clone https://github.com/YOUR_USERNAME/openclaw-lite
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
git clone https://github.com/YOUR_USERNAME/openclaw-lite
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
- **Total: ~150-200MB** ✅

## Compared to Full OpenClaw

| Feature | OpenClaw | OpenClaw Lite |
|---------|----------|---------------|
| WhatsApp | ✅ | ✅ |
| Telegram | ✅ | ❌ |
| Discord | ✅ | ❌ |
| Other channels | ✅ | ❌ |
| Browser tools | ✅ | ❌ |
| Canvas | ✅ | ❌ |
| TTS | ✅ | ❌ |
| Skills/plugins | ✅ | ❌ |
| Gateway server | ✅ | ❌ |
| Conversation memory | ✅ | ✅ |
| Claude intelligence | ✅ | ✅ |
| Lobster personality | ✅ | ✅ |
| RAM usage | 500-800MB | 150-200MB |
| Install size | 1.5GB+ | ~100MB |

## License

MIT - Same as OpenClaw

---

*EXFOLIATE! EXFOLIATE!* 🦞
