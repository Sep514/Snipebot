import axios from "axios";
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
  platform: "vinted";
}

export interface SearchOptions {
  maxPrice?: number;
  catalogIds?: number[];
}

const VINTED_BASE = "https://www.vinted.de";

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
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
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
    platform: "vinted",
  };
}

export async function searchVinted(
  searchText: string,
  options: SearchOptions = {},
): Promise<VintedItem[]> {
  try {
    // Build catalog URL like Python version (public page, no auth needed)
    const params = new URLSearchParams({
      "search_text": searchText,
      "order": "newest_first",
    });
    
    if (options.maxPrice && options.maxPrice > 0) {
      params.append("price_to", options.maxPrice.toString());
    }
    
    if (options.catalogIds && options.catalogIds.length > 0) {
      params.append("catalog_ids", options.catalogIds.join(","));
    }

    const catalogUrl = `${VINTED_BASE}/catalog?${params.toString()}`;
    logger.info(`🔍 Vinted Suche: ${searchText}`);

    // Simple headers - no authentication
    const headers: Record<string, string> = {
      "User-Agent": randomUA(),
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
    };

    // First request to get the page and extract items from embedded JSON
    const response = await axios.get(catalogUrl, {
      headers,
      timeout: 10000,
      validateStatus: () => true,
    });

    if (response.status === 401 || response.status === 403) {
      logger.warn(`⚠️ Vinted blockiert (${response.status})`);
      return [];
    }

    if (response.status !== 200) {
      logger.warn(`⚠️ Vinted Status ${response.status}`);
      return [];
    }

    // Extract JSON data from HTML (Vinted embeds it in <script> tags)
    const html = response.data;
    const jsonMatch = html.match(/<script[^>]*>window\.App\s*=\s*({.*?})<\/script>/s);
    
    if (!jsonMatch) {
      logger.warn("⚠️ Konnte keine Vinted-Daten im HTML finden");
      return [];
    }

    const appData = JSON.parse(jsonMatch[1]);
    const items: Record<string, any>[] = appData?.items?.catalogItems ?? [];
    
    if (items.length === 0) {
      logger.info("✅ Vinted: 0 Items gefunden");
      return [];
    }

    const parsed = items.map(parseItem).filter(item => item.id && item.price > 0);
    logger.info(`✅ Vinted: ${parsed.length} Items gefunden`);
    return parsed;

  } catch (error) {
    logger.error(`❌ Vinted Fehler: ${String(error)}`);
    return [];
  }
}

export async function findCheaperAlternatives(
  item: VintedItem,
  maxResults = 5,
): Promise<VintedItem[]> {
  if (!item.brand) return [];
  const targetPrice = item.price - 0.01;
  if (targetPrice <= 0) return [];

  try {
    const results = await searchVinted(`${item.brand} ${item.title.split(" ").slice(0, 3).join(" ")}`, {
      maxPrice: targetPrice,
    });

    return results
      .filter((r) => r.id !== item.id && r.price < item.price)
      .sort((a, b) => a.price - b.price)
      .slice(0, maxResults);
  } catch {
    return [];
  }
}
