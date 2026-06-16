import axios, { type AxiosInstance } from "axios";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger.js";

export interface VintedItem {
  id: string;
  title: string;
  price: number;
  currency: string;
  brand: string;
  size: string;
  condition: string;
  imageUrl: string;
  url: string;
  seller: string;
  sellerId?: string;
}

export interface SearchOptions {
  maxPrice?: number | undefined;
  catalogIds?: number[] | undefined;
}

const VINTED_BASE = "https://www.vinted.de";
const __dir = dirname(fileURLToPath(import.meta.url));
const TOKEN_CACHE_FILE = join(__dir, "..", "..", "vinted-token.json");

const CONDITION_LABELS: Record<string, string> = {
  "1": "Neu mit Etikett",
  "2": "Sehr gut",
  "3": "Gut",
  "4": "Befriedigend",
  new_with_tags: "Neu mit Etikett",
  very_good: "Sehr gut",
  good: "Gut",
  satisfactory: "Befriedigend",
};

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Session state ─────────────────────────────────────────────────────────────
interface CachedToken {
  token: string;
  savedAt: number;
}

let currentToken: string | null = null;
let currentClient: AxiosInstance | null = null;
let tokenExpiry = 0;
let blockedUntil = 0;
let refreshInProgress: Promise<boolean> | null = null;
let lastScrapeAttempt = 0;
let diskCacheInvalidated = false; // set true after a 403 so we skip the stale cache

// Load token from disk or VINTED_TOKEN env var
function loadPersistedToken(): string | null {
  // 1) Check env var first
  const envToken = process.env["VINTED_TOKEN"];
  if (envToken && envToken.trim()) {
    logger.info("Using VINTED_TOKEN from environment variable");
    return envToken.trim();
  }

  // 2) Check disk cache
  try {
    if (existsSync(TOKEN_CACHE_FILE)) {
      const raw = readFileSync(TOKEN_CACHE_FILE, "utf-8");
      const cached = JSON.parse(raw) as CachedToken;
      // Accept cached token up to 6 hours old
      if (Date.now() - cached.savedAt < 6 * 60 * 60 * 1000 && cached.token) {
        logger.info("Loaded Vinted token from disk cache");
        return cached.token;
      }
    }
  } catch { /* ignore */ }

  return null;
}

function persistToken(token: string): void {
  try {
    const data: CachedToken = { token, savedAt: Date.now() };
    writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(data), "utf-8");
    diskCacheInvalidated = false;
  } catch (err) {
    logger.warn({ err }, "Could not persist Vinted token to disk");
  }
}

function deleteCachedToken(): void {
  try {
    if (existsSync(TOKEN_CACHE_FILE)) {
      writeFileSync(TOKEN_CACHE_FILE, JSON.stringify({ token: "", savedAt: 0 }), "utf-8");
    }
  } catch { /* ignore */ }
  diskCacheInvalidated = true;
}

function buildClient(token: string): AxiosInstance {
  return axios.create({
    baseURL: VINTED_BASE,
    timeout: 20000,
    headers: {
      "User-Agent": randomUA(),
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
      Authorization: `Bearer ${token}`,
      Referer: `${VINTED_BASE}/catalog`,
      "X-Requested-With": "XMLHttpRequest",
    },
  });
}

// Try to get a token from any Vinted domain (different countries = different CF rules)
const VINTED_DOMAINS = [
  "https://www.vinted.de",
  "https://www.vinted.fr",
  "https://www.vinted.pl",
  "https://www.vinted.co.uk",
  "https://www.vinted.nl",
];

async function tryNoAuthRequest(): Promise<boolean> {
  // Test if catalog API works without any token (guest mode)
  try {
    const res = await axios.get(`${VINTED_BASE}/api/v2/catalog/items`, {
      params: { search_text: "Nike", order: "newest_first", per_page: 1 },
      headers: { "User-Agent": randomUA(), Accept: "application/json" },
      timeout: 10000,
      validateStatus: () => true,
    });
    if (res.status === 200 && res.data?.items) {
      logger.info("Vinted API accessible without token (guest mode)");
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

async function scrapeTokenFromDomain(base: string): Promise<string | null> {
  const paths = ["/", "/catalog"];
  for (const path of paths) {
    try {
      const ua = randomUA();
      const isChrome = ua.includes("Chrome");
      const res = await axios.get(`${base}${path}`, {
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
          "Accept-Encoding": "gzip, deflate, br",
          Connection: "keep-alive",
          "Cache-Control": "max-age=0",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1",
          ...(isChrome ? {
            "sec-ch-ua": `"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"`,
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": `"Windows"`,
          } : {}),
        },
        maxRedirects: 10,
        timeout: 12000,
        validateStatus: () => true,
      });

      const rawCookies: string[] = res.headers["set-cookie"] ?? [];
      for (const cookieStr of rawCookies) {
        const nameValue = cookieStr.split(";")[0]!;
        const eqIdx = nameValue.indexOf("=");
        if (eqIdx === -1) continue;
        const name = nameValue.slice(0, eqIdx).trim();
        const value = nameValue.slice(eqIdx + 1).trim();
        if (name === "access_token_web" && value) {
          logger.info({ domain: base, path }, "Token obtained from Vinted domain");
          return value;
        }
      }

      // Fallback: look for token embedded in HTML
      if (typeof res.data === "string") {
        const patterns = [
          /"access_token_web"\s*:\s*"([^"]+)"/,
          /"access_token"\s*:\s*"([^"]+)"/,
          /access_token_web%22%3A%22([^%"]+)/,
        ];
        for (const pattern of patterns) {
          const match = (res.data as string).match(pattern);
          if (match?.[1]) {
            logger.info({ domain: base, path }, "Token extracted from HTML");
            return match[1];
          }
        }
      }
    } catch { /* try next */ }
  }
  return null;
}

async function scrapeToken(): Promise<string | null> {
  for (const domain of VINTED_DOMAINS) {
    const token = await scrapeTokenFromDomain(domain);
    if (token) return token;
    await sleep(2000);
  }
  return null;
}

async function doRefreshSession(): Promise<boolean> {
  // Priority 1: environment variable (always wins)
  const envToken = process.env["VINTED_TOKEN"];
  if (envToken && envToken.trim()) {
    currentToken = envToken.trim();
    currentClient = buildClient(currentToken);
    tokenExpiry = Date.now() + 12 * 60 * 60 * 1000;
    logger.info("Session set from VINTED_TOKEN env var");
    return true;
  }

  // Priority 2: disk cache — skip if we know it's stale (403 was received)
  if (!diskCacheInvalidated) {
    const cached = loadPersistedToken();
    if (cached) {
      currentToken = cached;
      currentClient = buildClient(cached);
      tokenExpiry = Date.now() + 20 * 60 * 1000;
      logger.info("Session restored from disk cache");
      return true;
    }
  } else {
    logger.info("Disk cache invalidated after 403 — forcing fresh scrape");
  }

  // Priority 3: check if API works without any token (guest mode)
  const guestWorks = await tryNoAuthRequest();
  if (guestWorks) {
    currentToken = null;
    currentClient = axios.create({
      baseURL: VINTED_BASE,
      timeout: 20000,
      headers: {
        "User-Agent": randomUA(),
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
        Referer: `${VINTED_BASE}/catalog`,
      },
    });
    tokenExpiry = Date.now() + 10 * 60 * 1000; // 10 min guest sessions
    return true;
  }

  // Priority 4: scrape token from any Vinted domain
  logger.info("Attempting to scrape Vinted token from homepage(s)...");
  const scraped = await scrapeToken();
  if (scraped) {
    currentToken = scraped;
    currentClient = buildClient(scraped);
    tokenExpiry = Date.now() + 20 * 60 * 1000;
    persistToken(scraped);
    logger.info("Vinted session obtained via scrape");
    return true;
  }

  return false;
}

/**
 * Called before each scan cycle. Returns false if session is unavailable.
 * Respects cooldown to avoid hammering Vinted when blocked.
 */
export async function warmSession(): Promise<boolean> {
  // If cooldown active, only skip if we already have a working client
  if (Date.now() < blockedUntil) {
    if (currentClient && Date.now() < tokenExpiry) return true; // still valid — use it
    const mins = Math.ceil((blockedUntil - Date.now()) / 60000);
    logger.warn({ remainingMin: mins }, "Vinted cooldown active — skipping scan");
    return false;
  }

  // Session still valid
  if (currentClient && Date.now() < tokenExpiry) return true;

  // Already refreshing — wait
  if (refreshInProgress) return refreshInProgress;

  refreshInProgress = doRefreshSession().finally(() => { refreshInProgress = null; });

  const ok = await refreshInProgress;
  if (!ok) {
    logger.error("Vinted session unavailable — entering 5-min cooldown");
    blockedUntil = Date.now() + 5 * 60 * 1000;
  }
  return ok;
}

/**
 * Force-refresh session regardless of cooldown — used by button interactions
 * so Fake-Check / Pricecheck always work even after a scan cooldown.
 */
export async function ensureSession(): Promise<boolean> {
  if (currentClient && Date.now() < tokenExpiry) return true;
  if (refreshInProgress) return refreshInProgress;

  // Only throttle scrape attempts — max once every 90 seconds
  if (Date.now() - lastScrapeAttempt < 90_000) {
    logger.warn("ensureSession: throttled (last attempt < 90s ago)");
    return false;
  }

  lastScrapeAttempt = Date.now();
  refreshInProgress = doRefreshSession().finally(() => { refreshInProgress = null; });
  return refreshInProgress;
}

/**
 * Force-accept a user-provided token (e.g. from Discord command or env var).
 */
export function setManualToken(token: string): void {
  currentToken = token;
  currentClient = buildClient(token);
  tokenExpiry = Date.now() + 12 * 60 * 60 * 1000; // 12 hours
  blockedUntil = 0;
  persistToken(token);
  logger.info("Vinted token set manually");
}

export function parseItem(item: Record<string, unknown>): VintedItem {
  const photos = (item["photos"] as Record<string, unknown>[]) ?? [];
  const firstPhoto = photos[0] as Record<string, unknown> | undefined;
  const thumbnails = (firstPhoto?.["thumbnails"] as Record<string, unknown>[]) ?? [];
  const bigThumb = thumbnails.find((t) => (t["type"] as string) === "thumb310x430");
  const imageUrl =
    (bigThumb?.["url"] as string) ??
    (firstPhoto?.["url"] as string) ??
    (firstPhoto?.["full_size_url"] as string) ??
    "";

  const priceObj = (item["price"] as Record<string, unknown>) ?? {};
  const statusObj = (item["status"] as Record<string, unknown>) ?? {};
  const sizeObj = (item["size"] as Record<string, unknown>) ?? {};
  const userObj = (item["user"] as Record<string, unknown>) ?? {};
  const rawCondition = String(statusObj["value"] ?? item["status"] ?? "");

  return {
    id: String(item["id"] ?? ""),
    title: String(item["title"] ?? ""),
    price: parseFloat(String(priceObj["amount"] ?? item["price_numeric"] ?? "0")),
    currency: String(priceObj["currency_code"] ?? "EUR"),
    brand: String(item["brand_title"] ?? ""),
    size: String(sizeObj["title"] ?? item["size_title"] ?? ""),
    condition: CONDITION_LABELS[rawCondition] ?? rawCondition,
    imageUrl,
    url: `${VINTED_BASE}/items/${item["id"]}`,
    seller: String(userObj["login"] ?? ""),
    sellerId: String(userObj["id"] ?? ""),
  };
}

async function doSearch(searchText: string, options: SearchOptions): Promise<VintedItem[] | null> {
  if (!currentClient) return null;

  const params: Record<string, string | number> = {
    search_text: searchText,
    order: "newest_first",
    per_page: 20,
  };
  if (options.maxPrice && options.maxPrice > 0) params["price_to"] = options.maxPrice;
  if (options.catalogIds && options.catalogIds.length > 0) {
    params["catalog_ids"] = options.catalogIds.join(",");
  }

  try {
    const res = await currentClient.get("/api/v2/catalog/items", {
      params,
      validateStatus: () => true, // never throw on HTTP error codes
    });

    if (res.status === 401 || res.status === 403) {
      logger.warn({ status: res.status }, "Vinted auth error — invalidating session and disk cache");
      currentToken = null;
      currentClient = null;
      tokenExpiry = 0;
      deleteCachedToken(); // stale token causes 403 — wipe it so next refresh scrapes fresh
      return null; // signal: retry with fresh token
    }

    if (res.status !== 200) {
      logger.warn({ status: res.status }, "Unexpected Vinted status");
      return [];
    }

    const items: Record<string, unknown>[] = res.data?.items ?? [];
    return items.map(parseItem);
  } catch (err) {
    // Network error (timeout, DNS, etc.) — treat as temporary failure
    logger.warn({ err }, "Network error during Vinted search");
    return [];
  }
}

export async function searchVinted(
  searchText: string,
  options: SearchOptions = {},
): Promise<VintedItem[]> {
  // If we're in cooldown, don't even try
  if (Date.now() < blockedUntil) return [];

  // First attempt
  const result = await doSearch(searchText, options);
  if (result !== null) return result;

  // Got auth error — only retry token refresh if we haven't tried recently
  if (Date.now() - lastScrapeAttempt < 3 * 60 * 1000) {
    // Already tried scraping within last 3 min — don't hammer Cloudflare
    return [];
  }

  logger.info("Auth error on search — attempting token refresh...");
  lastScrapeAttempt = Date.now();
  const refreshed = await ensureSession();
  if (!refreshed) {
    logger.warn("Token refresh failed — entering 5-min cooldown");
    blockedUntil = Date.now() + 5 * 60 * 1000;
    return [];
  }

  // Retry once with new token
  return (await doSearch(searchText, options)) ?? [];
}

// Noise words to strip when building a search query from item title
const NOISE_WORDS = new Set([
  "und", "und", "mit", "für", "der", "die", "das", "ein", "eine", "in", "an", "auf",
  "neu", "new", "top", "super", "sehr", "gut", "kaum", "getragen", "vintage", "used",
  "original", "wie", "als", "aus", "ist", "von", "to", "the", "and", "with", "for",
  "gr", "gr.", "größe", "size", "xl", "xxl", "xs", "xxs", "s", "m", "l",
]);

function buildExactSearchQuery(brand: string, title: string): string {
  // Use full title, just clean it up a bit — keep as specific as possible
  const cleaned = title.replace(/[^\w\säöüÄÖÜß-]/g, " ").replace(/\s+/g, " ").trim();
  // Limit to ~60 chars so the API doesn't reject it
  return cleaned.length > 60 ? cleaned.slice(0, 60).trim() : cleaned;
}

export async function findCheaperAlternatives(
  item: VintedItem,
  maxResults = 5,
): Promise<VintedItem[]> {
  if (!item.brand) return [];
  // Look for the same item at strictly lower price (not just 90%)
  const targetPrice = item.price - 0.01;
  if (targetPrice <= 0) return [];

  // Build query from the full item title for maximum specificity
  const exactQuery = buildExactSearchQuery(item.brand, item.title);

  try {
    // First: exact title search → finds the same item from other sellers
    let results = await searchVinted(exactQuery, { maxPrice: targetPrice });

    // Fallback: brand + first 2 meaningful words if exact returns nothing
    if (results.length === 0) {
      const words = item.title
        .replace(/[^\w\säöüÄÖÜß]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !NOISE_WORDS.has(w.toLowerCase()))
        .slice(0, 2);
      const fallbackQuery = [item.brand, ...words].join(" ");
      results = await searchVinted(fallbackQuery, { maxPrice: targetPrice });
    }

    return results
      .filter((r) => r.id !== item.id && r.price < item.price)
      .sort((a, b) => a.price - b.price)
      .slice(0, maxResults);
  } catch {
    return [];
  }
}