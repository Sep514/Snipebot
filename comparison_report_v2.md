# 🔍 Enhanced Architectural Analysis - SnipeBot 2.0
**Reference:** SearchBotForDiscord (GitHub: JF-2121/SearchBotForDiscord)  
**Target:** Snipebo2.0 - Continuous Deal Monitoring Bot  
**Date:** 2026-06-17  
**Analyst:** Senior Python Architect

---

## 📋 Executive Summary

After analyzing the **SearchBotForDiscord** reference implementation, I've identified key architectural patterns that can be adapted for **SnipeBot 2.0**. The main difference: SearchBot is **on-demand** (user queries → bot responds), while SnipeBot is **continuous** (cron job → auto-posts deals).

**Key Takeaway:** We can reuse SearchBot's dual-scraper architecture (Vinted + Kleinanzeigen) while maintaining SnipeBot's autonomous monitoring behavior.

---

## 🔄 SearchBot vs SnipeBot - Core Differences

| Aspect | SearchBot (Reference) | SnipeBot (Current) | SnipeBot 2.0 (Goal) |
|--------|----------------------|-------------------|---------------------|
| **Trigger** | User command (`!snipe`, `/snipe`) | Cron job (every 5 min) | Cron job (1-5 min) |
| **Behavior** | Reactive (responds to queries) | Proactive (auto-posts deals) | Proactive (both platforms) |
| **Platforms** | Vinted + Kleinanzeigen | Vinted only | Vinted + Kleinanzeigen |
| **Language** | Python | TypeScript | TypeScript (keep) |
| **Architecture** | Single-file monolith | Modular (3 files) | Modular (enhanced) |
| **Deployment** | Manual (`python3 snipebot.py`) | None yet | Render.com ready |
| **Health Check** | None | None | Express server required |

---

## 🎯 Key Patterns from SearchBot to Adopt

### 1. **Dual-Scraper Architecture** ✅ ADOPT

SearchBot implements parallel scraping with result mixing:

```python
# SearchBot pattern (Python)
vinted_items = fetch_vinted(filters)
kleinanzeigen_items = fetch_kleinanzeigen(filters)
mixed_results = balance_results(vinted_items, kleinanzeigen_items, ratio=0.5)
```

**Adaptation for SnipeBot (TypeScript):**

```typescript
// src/scrapers/scraper-manager.ts
export class ScraperManager {
  private vintedScraper: VintedScraper;
  private kleinanzeigenScraper: KleinanzeigenScraper;

  async searchAll(query: string, config: ScraperConfig): Promise<ScrapedItem[]> {
    const [vintedResults, kleinanzeigenResults] = await Promise.allSettled([
      this.vintedScraper.search(query, config),
      this.kleinanzeigenScraper.search(query, config)
    ]);

    const vinted = vintedResults.status === 'fulfilled' ? vintedResults.value : [];
    const kleinanzeigen = kleinanzeigenResults.status === 'fulfilled' ? kleinanzeigenResults.value : [];

    // Mix results 50/50 or post to separate channels
    return this.mixResults(vinted, kleinanzeigen);
  }
}
```

### 2. **SearchFilters Pattern** ✅ ADAPT

SearchBot uses a comprehensive filter object:

```python
class SearchFilters:
    query: str
    category: str
    brand: str
    size: str
    gender: str
    price_min: int
    price_max: int
    page: int
    limit: int
```

**SnipeBot already has similar config:**

```typescript
// Current SnipeBot config (keep and enhance)
interface WatchConfig {
  brands: string[];
  maxPrice: number | undefined;
  active: boolean;
  categoryKey: string;
  gender: Gender;
  // ADD: platform selection
  platforms: ('vinted' | 'kleinanzeigen')[];
}
```

### 3. **Category Mapping** ✅ REUSE

SearchBot has 10+ category shortcuts. SnipeBot already has excellent category mapping:

```typescript
// SnipeBot's existing CATEGORIES (keep this!)
const CATEGORIES: Record<string, CategoryDef> = {
  pullover: { label: "Pullover & Strickjacken", keyword: "Pullover", ... },
  hoodie: { label: "Hoodies & Sweatshirts", keyword: "Hoodie", ... },
  // ... etc
}
```

**Action:** Extend with Kleinanzeigen-specific category IDs.

### 4. **Parallel Execution** ✅ ADOPT

SearchBot fetches both platforms concurrently. SnipeBot should do the same:

```typescript
// Current: Sequential per brand/category
for (const brand of watchConfig.brands) {
  const items = await searchVinted(brand, options);
  // Process items...
}

// Enhanced: Parallel across platforms
for (const brand of watchConfig.brands) {
  const [vintedItems, kleinanzeigenItems] = await Promise.all([
    searchVinted(brand, options),
    searchKleinanzeigen(brand, options)
  ]);
  // Process both...
}
```

---

## 🏗️ Proposed Architecture for SnipeBot 2.0

### File Structure

```
Snipebo2.0/
├── .env                          # Environment variables
├── .env.example                  # Template
├── package.json                  # Add express, dotenv
├── tsconfig.json
└── Snipebot/
    └── src/
        ├── index.ts              # Main entry (bot + server)
        ├── server.ts             # Health check endpoint
        ├── discordbot.ts         # Discord logic (refactored)
        ├── config/
        │   └── config.ts         # Centralized config
        ├── scrapers/
        │   ├── base-scraper.ts   # Abstract interface
        │   ├── vinted-scraper.ts # Existing (refactored)
        │   ├── kleinanzeigen-scraper.ts  # NEW
        │   └── scraper-manager.ts # Orchestration
        ├── models/
        │   └── types.ts          # Shared interfaces
        └── lib/
            ├── logger.ts         # Existing
            └── cache.ts          # Optional: Redis/memory cache
```

### Core Interfaces

```typescript
// src/models/types.ts
export interface ScrapedItem {
  id: string;
  title: string;
  price: number;
  currency: string;
  brand: string;
  size?: string;
  condition?: string;
  imageUrl: string;
  url: string;
  seller: string;
  platform: 'vinted' | 'kleinanzeigen';  // NEW
  scrapedAt: Date;
}

export interface ScraperConfig {
  maxPrice?: number;
  catalogIds?: number[];
  brands?: string[];
  gender?: 'herren' | 'damen' | 'beide';
  categoryKey?: string;
}

export abstract class BaseScraper {
  abstract search(query: string, config: ScraperConfig): Promise<ScrapedItem[]>;
  abstract warmSession(): Promise<boolean>;
  abstract ensureSession(): Promise<boolean>;
  readonly platform: 'vinted' | 'kleinanzeigen';
}
```

---

## 🆕 Kleinanzeigen.de Scraper Implementation

### Research Findings

Based on SearchBot's implementation:

1. **No Public API**: Kleinanzeigen.de doesn't have an official API
2. **HTML Scraping Required**: Parse search result pages
3. **URL Structure**: `https://www.kleinanzeigen.de/s-anzeigen/...`
4. **Rate Limiting**: More strict than Vinted (use delays)
5. **Authentication**: Not required for search (public listings)

### Implementation Strategy

```typescript
// src/scrapers/kleinanzeigen-scraper.ts
import axios from 'axios';
import * as cheerio from 'cheerio';  // ADD to package.json
import { BaseScraper, ScrapedItem, ScraperConfig } from '../models/types.js';
import { logger } from '../lib/logger.js';

export class KleinanzeigenScraper extends BaseScraper {
  readonly platform = 'kleinanzeigen' as const;
  private baseUrl = 'https://www.kleinanzeigen.de';
  private client: axios.AxiosInstance;

  constructor() {
    super();
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-DE,de;q=0.9',
      }
    });
  }

  async search(query: string, config: ScraperConfig): Promise<ScrapedItem[]> {
    try {
      const url = this.buildSearchUrl(query, config);
      const response = await this.client.get(url);
      const items = this.parseListings(response.data, query);
      
      logger.info(`Kleinanzeigen: Found ${items.length} items for "${query}"`);
      return items;
    } catch (error) {
      logger.error(`Kleinanzeigen search failed for "${query}":`, error);
      return [];
    }
  }

  private buildSearchUrl(query: string, config: ScraperConfig): string {
    const params = new URLSearchParams({
      keywords: query,
      sortingField: 'SORTING_DATE',  // Newest first
    });

    if (config.maxPrice) {
      params.append('maxPrice', config.maxPrice.toString());
    }

    // Category mapping (adapt from SearchBot)
    if (config.categoryKey) {
      const categoryId = this.getCategoryId(config.categoryKey);
      if (categoryId) params.append('categoryId', categoryId);
    }

    return `/s-anzeigen/deutschland/${query}/k0?${params.toString()}`;
  }

  private parseListings(html: string, query: string): ScrapedItem[] {
    const $ = cheerio.load(html);
    const items: ScrapedItem[] = [];

    // Kleinanzeigen uses article.aditem for listings
    $('article.aditem').each((_, element) => {
      try {
        const $item = $(element);
        
        const id = $item.attr('data-adid') || '';
        const title = $item.find('.ellipsis').text().trim();
        const priceText = $item.find('.aditem-main--middle--price-shipping--price').text().trim();
        const price = this.parsePrice(priceText);
        const url = this.baseUrl + $item.find('a.ellipsis').attr('href');
        const imageUrl = $item.find('img.galleryimage-element').attr('src') || '';
        
        // Kleinanzeigen doesn't always have brand/size in listing
        const brand = this.extractBrand(title, query);
        
        items.push({
          id,
          title,
          price,
          currency: 'EUR',
          brand,
          size: '—',  // Not available in search results
          condition: '—',  // Not available in search results
          imageUrl,
          url,
          seller: '—',  // Would need to visit detail page
          platform: 'kleinanzeigen',
          scrapedAt: new Date(),
        });
      } catch (err) {
        logger.warn('Failed to parse Kleinanzeigen item:', err);
      }
    });

    return items.filter(item => item.price > 0);
  }

  private parsePrice(priceText: string): number {
    // Handle formats: "50 €", "VB", "Zu verschenken"
    const match = priceText.match(/(\d+(?:[.,]\d+)?)/);
    return match ? parseFloat(match[1].replace(',', '.')) : 0;
  }

  private extractBrand(title: string, query: string): string {
    // Try to extract brand from title
    const brands = ['Nike', 'Adidas', 'Lacoste', 'Ralph Lauren', 'Carhartt'];
    for (const brand of brands) {
      if (title.toLowerCase().includes(brand.toLowerCase())) {
        return brand;
      }
    }
    return query.split(' ')[0] || '—';
  }

  private getCategoryId(categoryKey: string): string | null {
    // Map SnipeBot categories to Kleinanzeigen category IDs
    const mapping: Record<string, string> = {
      'pullover': '87',
      'hoodie': '87',
      'tshirt': '87',
      'hemd': '87',
      'jacke': '87',
      'hose': '87',
      'jeans': '87',
      'shorts': '87',
      'schuhe': '158',
      // Add more mappings as needed
    };
    return mapping[categoryKey] || null;
  }

  async warmSession(): Promise<boolean> {
    // Kleinanzeigen doesn't require session management
    return true;
  }

  async ensureSession(): Promise<boolean> {
    // No authentication needed for public search
    return true;
  }
}
```

---

## 🔧 Refactored Discord Bot Logic

### Key Changes

1. **Platform Selection**: Users can choose Vinted, Kleinanzeigen, or both
2. **Separate Channels**: Post Vinted deals to `#vinted-deals`, Kleinanzeigen to `#kleinanzeigen-deals`
3. **Unified Deal Format**: Same embed structure for both platforms
4. **Platform Badge**: Visual indicator in embeds

### Updated Slash Commands

```typescript
// Add platform subcommand
new SlashCommandBuilder()
  .setName("deals")
  .setDescription("Deal-Bot Steuerung")
  .addSubcommand(sub => 
    sub.setName("platform")
      .setDescription("Plattformen auswählen")
      .addStringOption(o => 
        o.setName("auswahl")
          .setDescription("Welche Plattformen durchsuchen?")
          .setRequired(true)
          .addChoices(
            { name: "Nur Vinted", value: "vinted" },
            { name: "Nur Kleinanzeigen", value: "kleinanzeigen" },
            { name: "Beide", value: "both" }
          )
      )
  )
  // ... existing subcommands
```

### Enhanced Deal Posting

```typescript
async function postDeals(client: Client) {
  if (!watchConfig.active) return;

  const scraperManager = new ScraperManager();
  const categoryKeys = watchConfig.categoryKey === 'alle' ? ALL_CATEGORY_KEYS : [watchConfig.categoryKey];

  for (const categoryKey of categoryKeys) {
    for (const brand of watchConfig.brands) {
      const searchText = buildSearchText(brand, categoryKey);
      
      // Search both platforms
      const allItems = await scraperManager.searchAll(searchText, {
        maxPrice: watchConfig.maxPrice,
        categoryKey,
        gender: watchConfig.gender,
      });

      // Separate by platform
      const vintedItems = allItems.filter(i => i.platform === 'vinted');
      const kleinanzeigenItems = allItems.filter(i => i.platform === 'kleinanzeigen');

      // Post to respective channels
      await postItemsToChannel(client, vintedItems, 'vinted-deals');
      await postItemsToChannel(client, kleinanzeigenItems, 'kleinanzeigen-deals');
      
      await sleep(2000);  // Rate limiting
    }
  }
}

function buildDealEmbed(item: ScrapedItem): EmbedBuilder {
  const platformEmoji = item.platform === 'vinted' ? '🛍️' : '📦';
  const platformName = item.platform === 'vinted' ? 'Vinted' : 'Kleinanzeigen';
  
  return new EmbedBuilder()
    .setColor(item.platform === 'vinted' ? 0x09b1ba : 0xff6b35)
    .setTitle(`${platformEmoji} ${item.brand || "—"} | ${item.title}`.slice(0, 250))
    .setURL(item.url)
    .addFields(
      { name: "💰 Preis", value: `${item.price.toFixed(2)} ${item.currency}`, inline: true },
      { name: "🏷️ Marke", value: item.brand || "—", inline: true },
      { name: "📐 Größe", value: item.size || "—", inline: true },
      { name: "✨ Zustand", value: item.condition || "—", inline: true },
      { name: "👤 Verkäufer", value: item.seller || "—", inline: true },
      { name: "🔗 Plattform", value: `${platformName} · DE`, inline: true },
    )
    .setFooter({ text: `Deal Bot • ${platformName}` })
    .setTimestamp();
    
  if (item.imageUrl) embed.setImage(item.imageUrl);
  return embed;
}
```

---

## 🚀 Render.com Deployment Setup

### 1. Health Check Server (REQUIRED)

```typescript
// src/server.ts
import express from 'express';
import { logger } from './lib/logger.js';

let botClient: any = null;

export function setBotClient(client: any) {
  botClient = client;
}

export async function startHealthServer(): Promise<void> {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.get('/health', (req, res) => {
    const isHealthy = botClient?.isReady() ?? false;
    const status = isHealthy ? 'healthy' : 'unhealthy';
    const statusCode = isHealthy ? 200 : 503;

    res.status(statusCode).json({
      status,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      bot: {
        connected: isHealthy,
        guilds: botClient?.guilds?.cache?.size ?? 0,
      }
    });
  });

  app.get('/', (req, res) => {
    res.send('SnipeBot 2.0 is running! 🚀');
  });

  app.listen(PORT, () => {
    logger.info(`Health server running on port ${PORT}`);
  });
}
```

### 2. Updated Main Entry Point

```typescript
// src/index.ts
import { startBot } from './discordbot.js';
import { startHealthServer, setBotClient } from './server.js';
import { logger } from './lib/logger.js';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  logger.info('🚀 Starting SnipeBot 2.0...');
  
  try {
    // Start health server first (Render.com needs this)
    await startHealthServer();
    logger.info('✅ Health server started');
    
    // Start Discord bot
    const client = await startBot();
    setBotClient(client);
    logger.info('✅ Discord bot started');
    
    logger.info('🎉 All services running successfully');
  } catch (error) {
    logger.error('❌ Fatal error during initialization:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

main();
```

### 3. Environment Variables

```bash
# .env.example
# Discord Configuration
DISCORD_BOT_TOKEN=your_discord_bot_token_here

# Vinted Configuration
VINTED_TOKEN=optional_vinted_access_token

# Whop Licensing (Optional)
WHOP_API_KEY=your_whop_api_key
WHOP_PRODUCT_ID=your_product_id

# Server Configuration
PORT=3000
NODE_ENV=production

# Rate Limiting
SCRAPE_INTERVAL_MINUTES=5
MAX_ITEMS_PER_SEARCH=20
```

### 4. Package.json Updates

```json
{
  "name": "snipebot",
  "version": "2.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "echo 'Tests coming soon'"
  },
  "dependencies": {
    "axios": "^1.6.0",
    "discord.js": "^14.14.0",
    "node-cron": "^3.0.3",
    "express": "^4.18.2",
    "dotenv": "^16.3.1",
    "cheerio": "^1.0.0-rc.12"
  },
  "devDependencies": {
    "typescript": "^5.3.3",
    "@types/node": "^20.11.0",
    "@types/node-cron": "^3.0.11",
    "@types/express": "^4.17.21"
  }
}
```

---

## 📊 Implementation Roadmap

### Phase 1: Foundation (1-2 hours)
- [x] Analyze SearchBot architecture
- [x] Create enhanced comparison report
- [ ] **WAITING FOR USER APPROVAL** ⏸️

### Phase 2: Core Refactoring (2-3 hours)
- [ ] Install new dependencies (`express`, `dotenv`, `cheerio`)
- [ ] Create `src/models/types.ts` with shared interfaces
- [ ] Create `src/scrapers/base-scraper.ts` abstract class
- [ ] Refactor `vinted-scraper.ts` to extend `BaseScraper`
- [ ] Create `src/config/config.ts` for centralized configuration
- [ ] Create `src/server.ts` health check endpoint
- [ ] Update `src/index.ts` for concurrent operations

### Phase 3: Kleinanzeigen Integration (2-3 hours)
- [ ] Implement `src/scrapers/kleinanzeigen-scraper.ts`
- [ ] Create `src/scrapers/scraper-manager.ts` orchestration
- [ ] Test Kleinanzeigen scraping locally
- [ ] Add category ID mappings
- [ ] Implement rate limiting for Kleinanzeigen

### Phase 4: Discord Bot Enhancement (1-2 hours)
- [ ] Add platform selection command
- [ ] Update deal posting logic for dual platforms
- [ ] Create separate channel posting logic
- [ ] Add platform badges to embeds
- [ ] Update status command to show both platforms

### Phase 5: Deployment Preparation (1 hour)
- [ ] Create `.env.example` file
- [ ] Update `package.json` with new dependencies
- [ ] Test locally with `.env` file
- [ ] Create deployment documentation
- [ ] Test health endpoint

### Phase 6: Render.com Deployment (30 min)
- [ ] Create Render.com web service
- [ ] Configure environment variables
- [ ] Deploy and monitor
- [ ] Verify health endpoint
- [ ] Test bot functionality in production

**Total Estimated Time:** 7-11 hours

---

## 🎯 Key Decisions Needed

### 1. **Channel Strategy**
**Option A:** Separate channels per platform
- `#vinted-deals` for Vinted items
- `#kleinanzeigen-deals` for Kleinanzeigen items
- **Pros:** Clear separation, easier filtering
- **Cons:** More channels to manage

**Option B:** Single channel with platform badges
- `#deals` for all items with emoji indicators
- **Pros:** Simpler setup, unified feed
- **Cons:** Mixed results, harder to filter

**Recommendation:** Option A (separate channels)

### 2. **Scraping Frequency**
- **Vinted:** Every 5 minutes (current)
- **Kleinanzeigen:** Every 5 minutes or staggered?
- **Recommendation:** Stagger by 2.5 minutes to avoid rate limits

### 3. **Result Mixing**
- **Option A:** 50/50 mix like SearchBot
- **Option B:** Post all from each platform separately
- **Recommendation:** Option B (post separately to respective channels)

### 4. **Kleinanzeigen Categories**
- Use same categories as Vinted?
- Map to Kleinanzeigen-specific categories?
- **Recommendation:** Map to Kleinanzeigen categories for better results

---

## 🚨 Important Notes

### Kleinanzeigen.de Considerations

1. **No Official API**: We're scraping HTML (may break if site changes)
2. **Rate Limiting**: Be conservative (5-10 sec delays between requests)
3. **robots.txt**: Check compliance
4. **Terms of Service**: Verify scraping is allowed
5. **IP Blocking**: Use rotating user agents, respect rate limits

### Legal & Ethical

- **Vinted:** Already implemented, seems stable
- **Kleinanzeigen:** Public listings, but verify ToS
- **Recommendation:** Add user agent rotation, implement exponential backoff

### Maintenance

- **HTML Structure Changes**: Monitor for breakage
- **Category ID Changes**: Keep mappings updated
- **Rate Limit Adjustments**: Be prepared to slow down

---

## ✅ Success Criteria

Before typing "GO", confirm:

1. ✅ Understand dual-scraper architecture from SearchBot
2. ✅ Agree with separate channels approach (or choose alternative)
3. ✅ Comfortable with HTML scraping for Kleinanzeigen
4. ✅ Ready for 7-11 hour implementation timeline
5. ✅ Have Render.com account ready for deployment

---

## 🎬 Next Steps

**I'm ready to implement when you type "GO"**

**Before we start, please confirm:**

1. **Channel Strategy:** Separate channels (Option A) or single channel (Option B)?
2. **Scraping Frequency:** 5 min for both or staggered?
3. **Categories:** Use all existing categories or focus on specific ones?
4. **Priority:** Kleinanzeigen integration first or Render.com deployment first?

**Type "GO" to proceed with implementation, or provide feedback/questions!**

---

**Report Generated:** 2026-06-17  
**Status:** ✅ Ready for implementation  
**Estimated Effort:** 7-11 hours for full implementation  
**Risk Level:** 🟡 Medium (HTML scraping dependency)
