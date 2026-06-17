import axios from "axios";
import { logger } from "./lib/logger.js";
const KLEINANZEIGEN_BASE = "https://www.kleinanzeigen.de";
const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];
function randomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}
// Kleinanzeigen category mappings
const CATEGORY_MAP = {
    pullover: "herrenbekleidung/pullover-strickjacken",
    hoodie: "herrenbekleidung/sweatshirts-hoodies",
    tshirt: "herrenbekleidung/t-shirts",
    hemd: "herrenbekleidung/hemden",
    jacke: "herrenbekleidung/jacken-maentel",
    hose: "herrenbekleidung/hosen",
    jeans: "herrenbekleidung/jeans",
    shorts: "herrenbekleidung/shorts",
    schuhe: "herrenschuhe",
    trainingsanzug: "herrenbekleidung/sportbekleidung",
    muetze: "accessoires-schmuck/muetzen-caps",
};
function extractPrice(priceText) {
    const match = priceText.match(/(\d+(?:[.,]\d+)?)/);
    if (!match)
        return 0;
    return parseFloat(match[1].replace(",", "."));
}
function parseCondition(text) {
    const lower = text.toLowerCase();
    if (lower.includes("neu"))
        return "Neu";
    if (lower.includes("sehr gut"))
        return "Sehr gut";
    if (lower.includes("gut"))
        return "Gut";
    return "Gebraucht";
}
export async function searchKleinanzeigen(searchText, options = {}) {
    try {
        const categoryPath = options.category && CATEGORY_MAP[options.category]
            ? `/s-${CATEGORY_MAP[options.category]}/`
            : "/s-";
        const searchUrl = `${KLEINANZEIGEN_BASE}${categoryPath}${encodeURIComponent(searchText)}/k0`;
        logger.info(`🔍 Kleinanzeigen Suche: ${searchUrl}`);
        const response = await axios.get(searchUrl, {
            headers: {
                "User-Agent": randomUA(),
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
                "Accept-Encoding": "gzip, deflate, br",
                Connection: "keep-alive",
                "Cache-Control": "max-age=0",
            },
            timeout: 15000,
            maxRedirects: 5,
        });
        const html = response.data;
        const items = [];
        // Parse HTML for ad listings
        // Kleinanzeigen uses article tags with class "aditem"
        const adPattern = /<article[^>]*class="[^"]*aditem[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
        let match;
        while ((match = adPattern.exec(html)) !== null && items.length < 20) {
            const adHtml = match[1];
            // Extract ID
            const idMatch = adHtml.match(/data-adid="(\d+)"/);
            if (!idMatch)
                continue;
            const id = idMatch[1];
            // Extract title
            const titleMatch = adHtml.match(/<a[^>]*class="[^"]*ellipsis[^"]*"[^>]*>(.*?)<\/a>/i);
            if (!titleMatch)
                continue;
            const title = titleMatch[1].replace(/<[^>]*>/g, "").trim();
            // Extract price
            const priceMatch = adHtml.match(/<p[^>]*class="[^"]*aditem-main--middle--price[^"]*"[^>]*>(.*?)<\/p>/i);
            let price = 0;
            if (priceMatch) {
                const priceText = priceMatch[1].replace(/<[^>]*>/g, "").trim();
                price = extractPrice(priceText);
            }
            // Skip if price exceeds max
            if (options.maxPrice && price > options.maxPrice)
                continue;
            if (price === 0)
                continue; // Skip "VB" or free items
            // Extract URL
            const urlMatch = adHtml.match(/<a[^>]*href="([^"]*)"[^>]*class="[^"]*ellipsis[^"]*"/i);
            const relativeUrl = urlMatch ? urlMatch[1] : `/s-anzeige/${id}`;
            const url = relativeUrl.startsWith("http") ? relativeUrl : `${KLEINANZEIGEN_BASE}${relativeUrl}`;
            // Extract image
            const imgMatch = adHtml.match(/<img[^>]*src="([^"]*)"[^>]*>/i);
            const imageUrl = imgMatch ? imgMatch[1] : "";
            // Extract location
            const locationMatch = adHtml.match(/<div[^>]*class="[^"]*aditem-main--top--left[^"]*"[^>]*>(.*?)<\/div>/i);
            const location = locationMatch
                ? locationMatch[1].replace(/<[^>]*>/g, "").trim().split("\n")[0]?.trim() || "Deutschland"
                : "Deutschland";
            // Extract brand from title
            const brandKeywords = ["nike", "adidas", "lacoste", "ralph lauren", "carhartt", "tommy", "puma", "reebok"];
            let brand = "";
            const lowerTitle = title.toLowerCase();
            for (const keyword of brandKeywords) {
                if (lowerTitle.includes(keyword)) {
                    brand = keyword.charAt(0).toUpperCase() + keyword.slice(1);
                    break;
                }
            }
            items.push({
                id,
                title,
                price,
                currency: "EUR",
                brand,
                size: "—",
                condition: parseCondition(title),
                imageUrl,
                url,
                seller: "—",
                location,
                platform: "kleinanzeigen",
            });
        }
        logger.info(`✅ Kleinanzeigen: ${items.length} Items gefunden`);
        return items;
    }
    catch (error) {
        logger.error(`❌ Kleinanzeigen Fehler: ${String(error)}`);
        return [];
    }
}
export async function findCheaperAlternatives(searchText, targetPrice, options = {}) {
    const items = await searchKleinanzeigen(searchText, {
        ...options,
        maxPrice: Math.floor(targetPrice - 1),
    });
    return items
        .filter((item) => item.price > 0 && item.price < targetPrice)
        .sort((a, b) => a.price - b.price)
        .slice(0, 5);
}
