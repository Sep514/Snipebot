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
    const params: Record<string, string | number> = {
      search_text: searchText,
      order: "newest_first",
      per_page: 20,
    };
    
    if (options.maxPrice && options.maxPrice > 0) {
      params["price_to"] = options.maxPrice;
    }
    
    if (options.catalogIds && options.catalogIds.length > 0) {
      params["catalog_ids"] = options.catalogIds.join(",");
    }

    logger.info(`🔍 Vinted Suche: ${searchText}`);

    const response = await axios.get(`${VINTED_BASE}/api/v2/catalog/items`, {
      params,
      headers: {
        "User-Agent": randomUA(),
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
        Referer: `${VINTED_BASE}/catalog`,
      },
      timeout: 15000,
      validateStatus: () => true,
    });

    if (response.status !== 200) {
      logger.warn(`⚠️ Vinted Status ${response.status} - möglicherweise blockiert`);
      return [];
    }

    const items: Record<string, any>[] = response.data?.items ?? [];
    const parsed = items.map(parseItem);
    
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
