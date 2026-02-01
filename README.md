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
- ~150MB RAM at runtime
- ~100MB disk space

## Quick Start

```bash
# Clone
git clone https://github.com/Hollando78/openclaw-lite
cd openclaw-lite

# Install dependencies
npm install

# Configure
cp .env.example .env
nano .env  # Add your ANTHROPIC_API_KEY

# Run
npm run dev

# Scan the QR code with WhatsApp > Linked Devices > Link a Device
```

## Termux (Android) - Full Setup

```bash
# 1. Install Termux from F-Droid (not Play Store)
#    https://f-droid.org/en/packages/com.termux/

# 2. Update and install Node.js
pkg update && pkg upgrade -y
pkg install nodejs-lts git -y

# 3. Clone and install
git clone https://github.com/Hollando78/openclaw-lite
cd openclaw-lite
npm install

# 4. Configure
cp .env.example .env
nano .env
# Add: ANTHROPIC_API_KEY=sk-ant-your-key-here
# Save: Ctrl+O, Enter, Ctrl+X

# 5. Run
npm run dev
```

## Run Persistently (Termux)

### Option 1: Termux:Boot (Auto-start on reboot)

```bash
# Install Termux:Boot from F-Droid
# https://f-droid.org/en/packages/com.termux.boot/

# Create boot script
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/openclaw.sh << 'EOF'
#!/data/data/com.termux/files/usr/bin/bash
cd ~/openclaw-lite
npm start >> ~/openclaw.log 2>&1 &
EOF
chmod +x ~/.termux/boot/openclaw.sh

# Open Termux:Boot once to enable auto-start
# Then reboot phone to test
```

### Option 2: tmux (Stay running when Termux closes)

```bash
# Install tmux
pkg install tmux

# Start in background session
tmux new -d -s openclaw 'cd ~/openclaw-lite && npm run dev'

# View logs
tmux attach -t openclaw

# Detach: Ctrl+B, then D
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
mkdir -p ~/.openclaw-lite
cp SOUL.example.md ~/.openclaw-lite/SOUL.md
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

## Resource Usage

### Memory (RAM)

| Component | Idle | Active |
|-----------|------|--------|
| Node.js runtime | ~30MB | ~40MB |
| Baileys (WhatsApp) | ~40MB | ~80MB |
| Anthropic SDK | ~5MB | ~10MB |
| Session cache | ~1MB | ~5MB |
| **Total** | **~80MB** | **~150MB** |

### Disk

| Item | Size |
|------|------|
| node_modules | ~100MB |
| Application code | ~30KB |
| WhatsApp auth state | ~50KB |
| Session files (per chat) | ~2-10KB each |

### API Cost

| Usage | Estimate |
|-------|----------|
| Per message (Sonnet) | ~$0.003-0.01 |
| 100 messages/day | ~$0.30-1.00/day |

### Alcatel 1C Fit

| Resource | Available | Used | Headroom |
|----------|-----------|------|----------|
| RAM | 1GB | ~150MB | ~850MB for Android |
| Storage | 8-16GB | ~100MB | Plenty |

## Production Build

```bash
# Build TypeScript (faster startup)
npm run build

# Run compiled version
npm start
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| QR won't scan | Delete `~/.openclaw-lite/auth` and restart |
| "Logged out" | Delete auth folder, restart, re-scan QR |
| High memory | Reduce `OPENCLAW_MAX_HISTORY` to 20 |
| API errors | Check `ANTHROPIC_API_KEY` is valid |
| Termux killed | Enable "Acquire wakelock" in Termux notification |

### Useful Commands

```bash
# Check if running
pgrep -f openclaw

# View logs (if using boot script)
tail -f ~/openclaw.log

# Stop
pkill -f openclaw

# Check memory usage
ps aux | grep node
```

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
| RAM usage | 500-800MB | ~150MB |
| Install size | 1.5GB+ | ~100MB |

## License

MIT - Same as OpenClaw
