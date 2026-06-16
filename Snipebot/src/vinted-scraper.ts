import axios, { type AxiosInstance } from "axios";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { logger } from "./lib/logger.js";

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
  maxPrice?: number;
  catalogIds?: number[];
}

const VINTED_BASE = "https://www.vinted.de";
// Railway-Fix: Nutze /tmp für beschreibbaren Speicherplatz im Cloud-Deployment
const TOKEN_CACHE_FILE = join("/tmp", "vinted-token.json");

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
let diskCacheInvalidated = false;

function loadPersistedToken(): string | null {
  const envToken = process.env["VINTED_TOKEN"];
  if (envToken && envToken.trim()) {
    logger.info("Benutze VINTED_TOKEN aus den Umgebungsvariablen");
    return envToken.trim();
  }

  try {
    if (existsSync(TOKEN_CACHE_FILE)) {
      const raw = readFileSync(TOKEN_CACHE_FILE, "utf-8");
      const cached = JSON.parse(raw) as CachedToken;
      if (Date.now() - cached.savedAt < 6 * 60 * 60 * 1000 && cached.token) {
        logger.info("Vinted-Token aus lokalem Cache geladen");
        return cached.token;
      }
    }
  } catch { /* ignorieren */ }

  return null;
}

function persistToken(token: string): void {
  try {
    const data: CachedToken = { token, savedAt: Date.now() };
    writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(data), "utf-8");
    diskCacheInvalidated = false;
  } catch (err) {
    logger.warn("Konnte Vinted-Token nicht auf Festplatte speichern: " + String(err));
  }
}

function deleteCachedToken(): void {
  try {
    if (existsSync(TOKEN_CACHE_FILE)) {
      writeFileSync(TOKEN_CACHE_FILE, JSON.stringify({ token: "", savedAt: 0 }), "utf-8");
    }
  } catch { /* ignorieren */ }
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

const VINTED_DOMAINS = [
  "https://www.vinted.de",
  "https://www.vinted.fr",
  "https://www.vinted.pl",
  "https://www.vinted.co.uk",
  "https://www.vinted.nl",
];

async function tryNoAuthRequest(): Promise<boolean> {
  try {
    const res = await axios.get(`${VINTED_BASE}/api/v2/catalog/items`, {
      params: { search_text: "Nike", order: "newest_first", per_page: 1 },
      headers: { "User-Agent": randomUA(), Accept: "application/json" },
      timeout: 10000,
      validateStatus: () => true,
    });
    if (res.status === 200 && res.data?.items) {
      logger.info("Vinted-API ohne Token erreichbar (Gast-Modus)");
      return true;
    }
  } catch { /* ignorieren */ }
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
          logger.info(`Token von Vinted Domain erhalten: ${base}${path}`);
          return value;
        }
      }

      if (typeof res.data === "string") {
        const patterns = [
          /"access_token_web"\s*:\s*"([^"]+)"/,
          /"access_token"\s*:\s*"([^"]+)"/,
          /access_token_web%22%3A%22([^%"]+)/,
        ];
        for (const pattern of patterns) {
          const match = (res.data as string).match(pattern);
          if (match?.[1]) {
            logger.info(`Token aus HTML extrahiert: ${base}${path}`);
            return match[1];
          }
        }
      }
    } catch { /* Nächsten Pfad versuchen */ }
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
  const envToken = process.env["VINTED_TOKEN"];
  if (envToken && envToken.trim()) {
    currentToken = envToken.trim();
    currentClient = buildClient(currentToken);
    tokenExpiry = Date.now() + 12 * 60 * 60 * 1000;
    logger.info("Session über VINTED_TOKEN Umgebungsvariable gesetzt");
    return true;
  }

  if (!diskCacheInvalidated) {
    const cached = loadPersistedToken();
    if (cached) {
      currentToken = cached;
      currentClient = buildClient(cached);
      tokenExpiry = Date.now() + 20 * 60 * 1000;
      logger.info("Session aus lokalem Cache wiederhergestellt");
      return true;
    }
  } else {
    logger.info("Lokal-Cache ungültig nach 403-Fehler — Scrape erzwungen");
  }

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
    tokenExpiry = Date.now() + 10 * 60 * 1000;
    return true;
  }

  logger.info("Versuche Vinted-Token von Startseiten zu scrapen...");
  const scraped = await scrapeToken();
  if (scraped) {
    currentToken = scraped;
    currentClient = buildClient(scraped);
    tokenExpiry = Date.now() + 20 * 60 * 1000;
    persistToken(scraped);
    logger.info("Vinted-Session erfolgreich gescraped");
    return true;
  }

  return false;
}

export async function warmSession(): Promise<boolean> {
  if (Date.now() < blockedUntil) {
    if (currentClient && Date.now() < tokenExpiry) return true;
    const mins = Math.ceil((blockedUntil - Date.now()) / 60000);
    logger.warn(`Vinted Cooldown aktiv — Überspringe Suche für noch ${mins} Min.`);
    return false;
  }

  if (currentClient && Date.now() < tokenExpiry) return true;
  if (refreshInProgress) return refreshInProgress;

  refreshInProgress = doRefreshSession().finally(() => { refreshInProgress = null; });

  const ok = await refreshInProgress;
  if (!ok) {
    logger.error("Vinted Session nicht verfügbar — 5 Minuten Cooldown aktiviert");
    blockedUntil = Date.now() + 5 * 60 * 1000;
  }
  return ok;
}

export async function ensureSession(): Promise<boolean> {
  if (currentClient && Date.now() < tokenExpiry) return true;
  if (refreshInProgress) return refreshInProgress;

  if (Date.now() - lastScrapeAttempt < 90_000) {
    logger.warn("ensureSession: Abgebrochen (Letzter Versuch liegt unter 90s)");
    return false;
  }

  lastScrapeAttempt = Date.now();
  refreshInProgress = doRefreshSession().finally(() => { refreshInProgress = null; });
  return refreshInProgress;
}

export function setManualToken(token: string): void {
  currentToken = token;
  currentClient = buildClient(token);
  tokenExpiry = Date.now() + 12 * 60 * 60 * 1000;
  blockedUntil = 0;
  persistToken(token);
  logger.info("Vinted-Token manuell gesetzt");
}

export function parseItem(item: Record<string, any>): VintedItem {
  const photos = (item["photos"] as Record<string, any>[]) ?? [];
  const firstPhoto = photos[0];
  const thumbnails = (firstPhoto?.["thumbnails"] as Record<string, any>[]) ?? [];
  const bigThumb = thumbnails.find((t) => (t["type"] as string) === "thumb310x430");
  const imageUrl =
    (bigThumb?.["url"] as string) ??
    (firstPhoto?.["url"] as string) ??
    (firstPhoto?.["full_size_url"] as string) ??
    "";

  const priceObj = (item["price"] as Record<string, any>) ?? {};
  const statusObj = (item["status"] as Record<string, any>) ?? {};
  const sizeObj = (item["size"] as Record<string, any>) ?? {};
  const userObj = (item["user"] as Record<string, any>) ?? {};
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
      validateStatus: () => true,
    });

    if (res.status === 401 || res.status === 403) {
      logger.warn(`Vinted Auth-Fehler (${res.status}) — Setze Session zurück`);
      currentToken = null;
      currentClient = null;
      tokenExpiry = 0;
      deleteCachedToken();
      return null;
    }

    if (res.status !== 200) {
      logger.warn(`Unerwarteter Vinted-Statuscode: ${res.status}`);
      return [];
    }

    const items: Record<string, any>[] = res.data?.items ?? [];
    return items.map(parseItem);
  } catch (err) {
    logger.warn("Netzwerkfehler während der Vinted-Suche: " + String(err));
    return [];
  }
}

export async function searchVinted(
  searchText: string,
  options: SearchOptions = {},
): Promise<VintedItem[]> {
  if (Date.now() < blockedUntil) return [];

  const result = await doSearch(searchText, options);
  if (result !== null) return result;

  if (Date.now() - lastScrapeAttempt < 3 * 60 * 1000) {
    return [];
  }

  logger.info("Fehler bei der Suche — Starte automatischen Token-Refresh...");
  lastScrapeAttempt = Date.now();
  const refreshed = await ensureSession();
  if (!refreshed) {
    logger.warn("Token-Refresh fehlgeschlagen — 5 Min Cooldown gestartet");
    blockedUntil = Date.now() + 5 * 60 * 1000;
    return [];
  }

  return (await doSearch(searchText, options)) ?? [];
}

const NOISE_WORDS = new Set([
  "und", "mit", "für", "der", "die", "das", "ein", "eine", "in", "an", "auf",
  "neu", "new", "top", "super", "sehr", "gut", "kaum", "getragen", "vintage", "used",
  "original", "wie", "als", "aus", "ist", "von", "to", "the", "and", "with", "for",
  "gr", "gr.", "größe", "size", "xl", "xxl", "xs", "xxs", "s", "m", "l",
]);

function buildExactSearchQuery(_brand: string, title: string): string {
  const cleaned = title.replace(/[^\w\säöüÄÖÜß-]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 60 ? cleaned.slice(0, 60).trim() : cleaned;
}

export async function findCheaperAlternatives(
  item: VintedItem,
  maxResults = 5,
): Promise<VintedItem[]> {
  if (!item.brand) return [];
  const targetPrice = item.price - 0.01;
  if (targetPrice <= 0) return [];

  const exactQuery = buildExactSearchQuery(item.brand, item.title);

  try {
    let results = await searchVinted(exactQuery, { maxPrice: targetPrice });

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