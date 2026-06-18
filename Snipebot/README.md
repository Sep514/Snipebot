# Snipebot 2.0 - Fully Automated Discord Deal Bot

**100% Automated** - No cookies, no tokens, no manual updates needed!

Fast Discord bot that searches Vinted every 2 minutes and posts the top 3 cheapest deals.

## Features

- ⚡ **Fast**: Searches every 2 minutes
- 🤖 **Fully Automated**: No manual cookie updates needed
- 🎯 **Smart**: Posts only the 3 cheapest deals per brand
- 🔍 **Multi-brand**: Nike, Adidas, Lacoste, Ralph Lauren, Carhartt
- 📊 **Detailed logging**: Track exactly what the bot is doing
- 🎨 **Rich embeds**: Beautiful Discord embeds with images
- 💰 **Price check**: Find cheaper alternatives
- 🔍 **Fake check**: Analyze deals for authenticity
- ❤️ **Save deals**: Save deals to DMs

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Create `.env` File

```bash
cp .env.example .env
```

Edit `.env` and add your Discord bot token:

```env
DISCORD_BOT_TOKEN=your_discord_bot_token
```

### 3. Build & Run

```bash
npm run build
npm start
```

## Discord Setup

### Required Channel

Create a single channel in your Discord server:
- **#deals** - All deals will be posted here

That's it! No complex category structure needed.

### Bot Commands

- `/deals start` - Start deal search
- `/deals stop` - Stop deal search
- `/deals status` - Show current status
- `/deals marken <list>` - Set brands (e.g., Nike,Adidas)
- `/deals maxpreis <price>` - Set max price in EUR
- `/deals geschlecht <type>` - Filter by gender (herren/damen/beide)
- `/deals suche` - Search now
- `/deals reset` - Clear cache

## Deploy to Render.com

1. Push code to GitHub
2. Create new **Web Service** on Render.com
3. Set **Root Directory**: `Snipebot`
4. Set **Build Command**: `npm install && npm run build`
5. Set **Start Command**: `npm start`
6. Add environment variable:
   - `DISCORD_BOT_TOKEN`
7. Deploy!

### Keep Bot Alive

Use UptimeRobot to ping your Render URL every 5 minutes:
- Monitor Type: HTTP(s)
- URL: `https://your-app.onrender.com/`
- Interval: 5 minutes

## How It Works

The bot uses a simplified approach that works reliably:

1. **No Authentication**: Uses public Vinted API without cookies
2. **Simple Searches**: Searches by brand name only (no complex filters)
3. **Single Channel**: Posts all deals to one channel
4. **Smart Sorting**: Always shows the 3 cheapest deals first

This approach avoids rate limiting and works 24/7 without manual intervention.

## Troubleshooting

### No deals found

- Check if brands are spelled correctly
- Try increasing max price with `/deals maxpreis 100`
- Check Discord channel is named exactly `deals`
- Look at logs for detailed error messages

### Bot stuck on "Deal-Suche läuft..."

Check the logs - they show detailed progress:
- Which category is being searched
- How many items found
- Which deals are posted

## Architecture

- **TypeScript** for type safety
- **discord.js** for Discord integration
- **axios** for HTTP requests
- **node-cron** for scheduled searches (every 2 minutes)
- **Simple HTTP server** for Render.com health checks

## Why This Works Better

Unlike complex setups that require:
- ❌ Manual cookie updates every 6 hours
- ❌ Complex category structures
- ❌ Headless browsers

This bot:
- ✅ Works 24/7 without intervention
- ✅ Simple single-channel setup
- ✅ No authentication needed
- ✅ Fast and reliable

## License

MIT