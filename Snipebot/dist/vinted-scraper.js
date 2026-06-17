import axios from "axios";
import { logger } from "./lib/logger.js";
const VINTED_BASE = "https://www.vinted.de";
const CONDITION_LABELS = {
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
function randomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}
export function parseItem(item) {
    const photos = item["photos"] ?? [];
    const firstPhoto = photos[0];
    const thumbnails = firstPhoto?.["thumbnails"] ?? [];
    const bigThumb = thumbnails.find((t) => t["type"] === "thumb310x430");
    const imageUrl = bigThumb?.["url"] ??
        firstPhoto?.["url"] ??
        firstPhoto?.["full_size_url"] ??
        "";
    const priceObj = item["price"] ?? {};
    const statusObj = item["status"] ?? {};
    const sizeObj = item["size"] ?? {};
    const userObj = item["user"] ?? {};
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
export async function searchVinted(searchText, options = {}) {
    try {
        const params = {
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
        const items = response.data?.items ?? [];
        const parsed = items.map(parseItem);
        logger.info(`✅ Vinted: ${parsed.length} Items gefunden`);
        return parsed;
    }
    catch (error) {
        logger.error(`❌ Vinted Fehler: ${String(error)}`);
        return [];
    }
}
export async function findCheaperAlternatives(item, maxResults = 5) {
    if (!item.brand)
        return [];
    const targetPrice = item.price - 0.01;
    if (targetPrice <= 0)
        return [];
    try {
        const results = await searchVinted(`${item.brand} ${item.title.split(" ").slice(0, 3).join(" ")}`, {
            maxPrice: targetPrice,
        });
        return results
            .filter((r) => r.id !== item.id && r.price < item.price)
            .sort((a, b) => a.price - b.price)
            .slice(0, maxResults);
    }
    catch {
        return [];
    }
}
