import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  TextChannel,
  Events,
  ActivityType,
  SlashCommandBuilder,
  REST,
  Routes,
  ChatInputCommandInteraction,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} from "discord.js";
import cron from "node-cron";
import axios from "axios";
import {
  searchVinted,
  findCheaperAlternatives,
  warmSession,
  ensureSession,
  setManualToken,
  type VintedItem,
} from "./vinted-scraper.js";
import { logger } from "../lib/logger.js";

const FALLBACK_CHANNEL_ID = "1483482170583678976";
const DEFAULT_BRANDS = ["Nike", "Adidas", "Lacoste", "Ralph Lauren", "Carhartt"];

// Cache für gepostete Items (itemId → VintedItem)
const itemCache = new Map<string, VintedItem>();
const MAX_CACHE_SIZE = 2000;

function cacheItem(item: VintedItem) {
  itemCache.set(item.id, item);
  if (itemCache.size > MAX_CACHE_SIZE) {
    const firstKey = itemCache.keys().next().value;
    if (firstKey) itemCache.delete(firstKey);
  }
}

// ─── Whop Lizenz ─────────────────────────────────────────────────────────────
const WHOP_API_KEY = process.env["WHOP_API_KEY"];
const WHOP_PRODUCT_ID = process.env["WHOP_PRODUCT_ID"];
const licenseCache = new Map<string, { valid: boolean; expiry: number }>();

async function isGuildLicensed(guildId: string): Promise<boolean> {
  if (!WHOP_API_KEY || !WHOP_PRODUCT_ID) return true;
  const cached = licenseCache.get(guildId);
  if (cached && Date.now() < cached.expiry) return cached.valid;
  try {
    const res = await axios.get("https://api.whop.com/api/v2/memberships", {
      headers: { Authorization: `Bearer ${WHOP_API_KEY}` },
      params: { product_id: WHOP_PRODUCT_ID, metadata_discord_guild_id: guildId, valid: true },
      timeout: 8000,
    });
    const valid = (res.data?.data?.length ?? 0) > 0;
    licenseCache.set(guildId, { valid, expiry: Date.now() + 10 * 60 * 1000 });
    return valid;
  } catch (err) {
    logger.error({ err, guildId }, "Whop license check failed");
    return false;
  }
}

// ─── Kategorien ──────────────────────────────────────────────────────────────
type Gender = "herren" | "damen" | "beide";

interface CategoryDef {
  label: string;
  keyword: string;
  channelName: string;
  herrenCatalogIds: number[];
  damenCatalogIds: number[];
}

const CATEGORIES: Record<string, CategoryDef> = {
  pullover: { label: "Pullover & Strickjacken", keyword: "Pullover", channelName: "pullover-strickjacken", herrenCatalogIds: [79], damenCatalogIds: [80] },
  hoodie: { label: "Hoodies & Sweatshirts", keyword: "Hoodie", channelName: "hoodies-sweatshirts", herrenCatalogIds: [267], damenCatalogIds: [266] },
  tshirt: { label: "T-Shirts", keyword: "T-Shirt", channelName: "t-shirts", herrenCatalogIds: [76], damenCatalogIds: [77] },
  hemd: { label: "Hemden", keyword: "Hemd", channelName: "hemden", herrenCatalogIds: [536], damenCatalogIds: [] },
  jacke: { label: "Jacken & Mäntel", keyword: "Jacke", channelName: "jacken-mäntel", herrenCatalogIds: [1206], damenCatalogIds: [1037] },
  hose: { label: "Hosen", keyword: "Hose", channelName: "hosen", herrenCatalogIds: [34], damenCatalogIds: [33] },
  jeans: { label: "Jeans", keyword: "Jeans", channelName: "jeans", herrenCatalogIds: [257], damenCatalogIds: [10] },
  shorts: { label: "Shorts", keyword: "Shorts", channelName: "shorts", herrenCatalogIds: [82], damenCatalogIds: [11] },
  schuhe: { label: "Schuhe", keyword: "Schuhe", channelName: "schuhe", herrenCatalogIds: [1242], damenCatalogIds: [16] },
  trainingsanzug: { label: "Trainingsanzug", keyword: "Trainingsanzug", channelName: "trainingsanzug", herrenCatalogIds: [2050], damenCatalogIds: [2994] },
  muetze: { label: "Mützen & Caps", keyword: "Mütze", channelName: "mützen-caps", herrenCatalogIds: [89], damenCatalogIds: [88] },
};

const ALL_CATEGORY_KEYS = Object.keys(CATEGORIES);

const CATEGORY_CHOICES = [
  { name: "Alle Kategorien", value: "alle" },
  ...Object.entries(CATEGORIES).map(([value, def]) => ({ name: def.label, value })),
];

interface WatchConfig {
  brands: string[];
  maxPrice: number | undefined;
  active: boolean;
  categoryKey: string;
  gender: Gender;
}

const watchConfig: WatchConfig = {
  brands: [...DEFAULT_BRANDS],
  maxPrice: undefined,
  active: true,
  categoryKey: "alle",
  gender: "beide",
};

const seenItemIds = new Set<string>();

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────
function genderLabel(g: Gender): string {
  if (g === "herren") return "Herren";
  if (g === "damen") return "Damen";
  return "Herren & Damen";
}

function buildSearchText(brand: string, categoryKey: string): string {
  const cat = CATEGORIES[categoryKey];
  if (!cat || !cat.keyword) return brand;
  return `${brand} ${cat.keyword}`;
}

async function findChannelInSection(client: Client, channelName: string, sectionName: string): Promise<TextChannel | null> {
  for (const [, guild] of client.guilds.cache) {
    const category = guild.channels.cache.find((c) => c.name.toLowerCase() === sectionName.toLowerCase() && c.type === 4);
    if (!category) continue;
    const ch = guild.channels.cache.find((c) => c.name === channelName && c instanceof TextChannel && (c as TextChannel).parentId === category.id) as TextChannel | undefined;
    if (ch) return ch;
  }
  return null;
}

async function findChannelByName(client: Client, channelName: string): Promise<TextChannel | null> {
  for (const [, guild] of client.guilds.cache) {
    const ch = guild.channels.cache.find((c) => c.name === channelName && c instanceof TextChannel) as TextChannel | undefined;
    if (ch) return ch;
  }
  return null;
}

async function getFallbackChannel(client: Client): Promise<TextChannel | null> {
  try {
    const ch = await client.channels.fetch(FALLBACK_CHANNEL_ID);
    if (ch instanceof TextChannel) return ch;
  } catch { /* ignore */ }
  return null;
}

// ─── Fake-Check Logik (aus Cache-Daten) ──────────────────────────────────────
function runFakeCheck(item: VintedItem): { embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> } {
  const warnings: string[] = [];
  const positives: string[] = [];
  let riskScore = 0;

  // Preis-Check
  const knownExpensiveBrands = ["ralph lauren", "lacoste", "carhartt"];
  const isExpensiveBrand = knownExpensiveBrands.some((b) => item.brand.toLowerCase().includes(b));

  if (item.price < 3) { warnings.push("💸 Preis extrem niedrig (unter 3€)"); riskScore += 35; }
  else if (item.price < 8 && isExpensiveBrand) { warnings.push("💸 Preis sehr niedrig für diese Marke"); riskScore += 20; }
  else if (item.price < 5) { warnings.push("💸 Preis sehr niedrig"); riskScore += 15; }
  else { positives.push("💰 Preis im normalen Bereich"); }

  // Zustand
  if (!item.condition || item.condition === "—") { warnings.push("❓ Kein Zustand angegeben"); riskScore += 10; }
  else if (item.condition.toLowerCase().includes("neu")) { positives.push("✨ Als 'Neu' eingestuft"); }
  else { positives.push(`✨ Zustand: ${item.condition}`); }

  // Größe
  if (!item.size || item.size === "—") { warnings.push("📐 Keine Größenangabe"); riskScore += 10; }
  else { positives.push(`📐 Größe angegeben: ${item.size}`); }

  // Marke im Titel
  if (item.brand && !item.title.toLowerCase().includes(item.brand.toLowerCase())) {
    warnings.push("🏷️ Markenname nicht im Titel"); riskScore += 15;
  } else if (item.brand) {
    positives.push("🏷️ Markenname im Titel bestätigt");
  }

  // Verkäufer
  if (!item.seller || item.seller === "—") { warnings.push("👤 Kein Verkäufername"); riskScore += 10; }
  else { positives.push(`👤 Verkäufer: ${item.seller}`); }

  let verdict: string;
  let color: number;
  if (riskScore >= 45) { verdict = "🔴 HOHES RISIKO — Vorsicht!"; color = 0xff0000; }
  else if (riskScore >= 20) { verdict = "🟡 MITTLERES RISIKO — Genau prüfen"; color = 0xffa500; }
  else { verdict = "🟢 NIEDRIGES RISIKO — Wirkt legitim"; color = 0x00cc66; }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🔍 Fake-Check: ${item.brand || "—"} | ${item.title}`.slice(0, 250))
    .setURL(item.url)
    .setDescription(`**${verdict}**\nRisiko-Score: **${riskScore}/100**`)
    .addFields(
      { name: "💰 Preis", value: `${item.price.toFixed(2)} ${item.currency}`, inline: true },
      { name: "🏷️ Marke", value: item.brand || "—", inline: true },
      { name: "📐 Größe", value: item.size || "—", inline: true },
      { name: "✨ Zustand", value: item.condition || "—", inline: true },
      { name: "👤 Verkäufer", value: item.seller || "—", inline: true },
    )
    .setFooter({ text: "Fake-Check • Snipebot" })
    .setTimestamp();

  if (warnings.length > 0) embed.addFields({ name: "⚠️ Warnzeichen", value: warnings.join("\n") });
  if (positives.length > 0) embed.addFields({ name: "✅ Positive Zeichen", value: positives.join("\n") });
  if (item.imageUrl) embed.setThumbnail(item.imageUrl);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("🔗 Inserat öffnen").setStyle(ButtonStyle.Link).setURL(item.url),
  );

  return { embed, row };
}

// ─── Embeds & Buttons ─────────────────────────────────────────────────────────
function buildDealEmbed(item: VintedItem): EmbedBuilder {
  const priceStr = `${item.price.toFixed(2)} ${item.currency}`;
  const embed = new EmbedBuilder()
    .setColor(0x09b1ba)
    .setTitle(`${item.brand || "—"} | ${item.title}`.slice(0, 250))
    .setURL(item.url)
    .addFields(
      { name: "💰 Preis", value: priceStr, inline: true },
      { name: "🏷️ Marke", value: item.brand || "—", inline: true },
      { name: "📐 Größe", value: item.size || "—", inline: true },
      { name: "✨ Zustand", value: item.condition || "—", inline: true },
      { name: "👤 Verkäufer", value: item.seller || "—", inline: true },
      { name: "🔗 Plattform", value: "Vinted · DE", inline: true },
    )
    .setFooter({ text: "Deal Bot • Vinted" })
    .setTimestamp();
  if (item.imageUrl) embed.setImage(item.imageUrl);
  return embed;
}

function buildDealButtons(item: VintedItem): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("🛒 Ansehen").setStyle(ButtonStyle.Link).setURL(item.url),
    new ButtonBuilder().setLabel("💬 Anschreiben").setStyle(ButtonStyle.Link).setURL(`${item.url}#message`),
    new ButtonBuilder().setCustomId(`save_${item.id}`).setLabel("❤️ Merken").setStyle(ButtonStyle.Danger),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`interested_${item.id}`).setLabel("👍 Interessiert").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`fakecheck_${item.id}`).setLabel("🔍 Fake-Check").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`pricecheck_${item.id}`).setLabel("💰 Pricecheck").setStyle(ButtonStyle.Success),
  );
  return [row1, row2];
}

// ─── Deal-Posting ─────────────────────────────────────────────────────────────
interface GenderTarget {
  section: string;
  catalogIdsFn: (categoryKey: string) => number[];
}

async function postDealsForGenderTarget(client: Client, categoryKeys: string[], target: GenderTarget) {
  for (const categoryKey of categoryKeys) {
    const cat = CATEGORIES[categoryKey];
    if (!cat) continue;
    // Small delay between categories to spread Vinted API load
    await new Promise((r) => setTimeout(r, 1500));

    const catalogIds = target.catalogIdsFn(categoryKey);
    if (catalogIds.length === 0) continue;

    const channel =
      (await findChannelInSection(client, cat.channelName, target.section)) ??
      (await getFallbackChannel(client));

    if (!channel) {
      logger.warn({ channelName: cat.channelName, section: target.section }, "Channel not found, skipping");
      continue;
    }

    for (const brand of watchConfig.brands) {
      try {
        const searchText = buildSearchText(brand, categoryKey);
        const items = await searchVinted(searchText, {
          maxPrice: watchConfig.maxPrice,
          catalogIds,
        });
        const newItems = items.filter((i) => !seenItemIds.has(i.id));

        for (const item of newItems.slice(0, 3)) {
          seenItemIds.add(item.id);
          cacheItem(item);
          const embed = buildDealEmbed(item);
          const rows = buildDealButtons(item);
          await channel.send({ embeds: [embed], components: rows });
          await new Promise((r) => setTimeout(r, 800));
        }

        logger.info({ brand, category: cat.label, channel: cat.channelName, section: target.section, newItems: newItems.length }, "Checked brand");
      } catch (err) {
        logger.error({ err, brand, category: categoryKey, section: target.section }, "Error fetching deals for brand");
      }
      // Delay between brand searches to avoid Vinted rate limiting
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// Throttle: Benachrichtigung max. 1x pro Stunde schicken
let lastBlockedNotify = 0;

async function notifyBlocked(client: Client) {
  if (Date.now() - lastBlockedNotify < 60 * 60 * 1000) return; // max 1x/Stunde
  lastBlockedNotify = Date.now();

  const embed = new EmbedBuilder()
    .setColor(0xff4444)
    .setTitle("⚠️ Vinted-Token abgelaufen")
    .setDescription(
      "Der Bot kann nicht mehr auf Vinted zugreifen.\n\n" +
      "**So erneuerst du den Token (2 Minuten):**\n" +
      "1️⃣ Öffne **vinted.de** im Browser und logge dich ein\n" +
      "2️⃣ Drücke **F12** → Tab **Application** → **Cookies** → `www.vinted.de`\n" +
      "3️⃣ Suche `access_token_web` → Wert **kopieren**\n" +
      "4️⃣ Schick mir den kopierten Wert einfach **per DM** — oder nutze `/deals token`\n\n" +
      "✅ Token gilt dann ca. **12 Stunden**",
    )
    .setFooter({ text: "Snipebot • Token-Erneuerung" })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("🔗 Vinted öffnen")
      .setStyle(ButtonStyle.Link)
      .setURL("https://www.vinted.de"),
  );

  // 1) DM an Bot-Owner
  if (botOwnerId) {
    try {
      const owner = await client.users.fetch(botOwnerId);
      const dm = await owner.createDM();
      await dm.send({ embeds: [embed], components: [row] });
      logger.info("Blocked notification sent to bot owner via DM");
    } catch (err) {
      logger.warn({ err }, "Could not DM bot owner");
    }
  }

  // 2) Nachricht im Fallback-Channel
  try {
    const ch = await getFallbackChannel(client);
    if (ch) await ch.send({ embeds: [embed], components: [row] });
  } catch { /* ignore */ }
}

async function postDeals(client: Client) {
  if (!watchConfig.active) return;

  // Warm up the Vinted session before scanning — skip entire cycle if blocked
  const sessionOk = await warmSession();
  if (!sessionOk) {
    logger.warn("Skipping scan cycle — Vinted session unavailable (rate-limited or blocked)");
    await notifyBlocked(client);
    return;
  }

  const categoryKeys = watchConfig.categoryKey === "alle" ? ALL_CATEGORY_KEYS : [watchConfig.categoryKey];
  const targets: GenderTarget[] = [];

  if (watchConfig.gender === "herren" || watchConfig.gender === "beide") {
    targets.push({ section: "men", catalogIdsFn: (key) => CATEGORIES[key]?.herrenCatalogIds ?? [] });
  }
  if (watchConfig.gender === "damen" || watchConfig.gender === "beide") {
    targets.push({ section: "woman", catalogIdsFn: (key) => CATEGORIES[key]?.damenCatalogIds ?? [] });
  }

  for (const target of targets) {
    await postDealsForGenderTarget(client, categoryKeys, target);
  }
}

// ─── Slash Commands ───────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("deals")
    .setDescription("Deal-Bot Steuerung")
    .addSubcommand((sub) => sub.setName("start").setDescription("Deal-Suche starten"))
    .addSubcommand((sub) => sub.setName("stop").setDescription("Deal-Suche stoppen"))
    .addSubcommand((sub) => sub.setName("status").setDescription("Aktuellen Status anzeigen"))
    .addSubcommand((sub) =>
      sub.setName("marken").setDescription("Marken einstellen (kommagetrennt)")
        .addStringOption((o) => o.setName("liste").setDescription("z.B. Nike,Adidas,Lacoste").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("maxpreis").setDescription("Maximalen Preis in EUR einstellen")
        .addIntegerOption((o) => o.setName("preis").setDescription("z.B. 50 für max. 50 EUR (0 = kein Limit)").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("kategorie").setDescription("Nur eine bestimmte Kategorie suchen")
        .addStringOption((o) => o.setName("typ").setDescription("Kategorie auswählen").setRequired(true).addChoices(...CATEGORY_CHOICES)),
    )
    .addSubcommand((sub) =>
      sub.setName("geschlecht").setDescription("Nach Herren / Damen / Beide filtern")
        .addStringOption((o) =>
          o.setName("typ").setDescription("Geschlecht auswählen").setRequired(true)
            .addChoices({ name: "Herren", value: "herren" }, { name: "Damen", value: "damen" }, { name: "Beide", value: "beide" }),
        ),
    )
    .addSubcommand((sub) => sub.setName("suche").setDescription("Jetzt sofort nach Deals suchen"))
    .addSubcommand((sub) => sub.setName("reset").setDescription("Cache zurücksetzen (zeigt alte Deals erneut)"))
    .addSubcommand((sub) =>
      sub.setName("token").setDescription("Vinted access_token_web Cookie manuell setzen")
        .addStringOption((o) => o.setName("wert").setDescription("access_token_web Cookie-Wert aus Browser DevTools").setRequired(true)),
    ),

  new SlashCommandBuilder()
    .setName("lizenz")
    .setDescription("Zeigt den Lizenzstatus dieses Servers"),
];

// ─── Bot Owner ID (für DM-Benachrichtigungen) ─────────────────────────────────
// Wird beim ersten Ready-Event automatisch gesetzt (= Owner des Bot-Accounts)
let botOwnerId: string | null = null;

// ─── Bot Start ────────────────────────────────────────────────────────────────
export async function startBot() {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) { logger.error("DISCORD_BOT_TOKEN is not set"); return; }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessages, // für Token per DM empfangen
    ],
    partials: [2, 3], // CHANNEL + MESSAGE partials für DMs
  });

  client.once(Events.ClientReady, async (c) => {
    logger.info({ tag: c.user.tag }, "Discord bot logged in");
    c.user.setActivity("🔍 Deal-Suche läuft...", { type: ActivityType.Watching });

    // Bot-Owner-ID ermitteln (für DM-Benachrichtigungen)
    try {
      const app = await c.application.fetch();
      botOwnerId = app.owner && "id" in app.owner ? app.owner.id : null;
      if (botOwnerId) logger.info({ botOwnerId }, "Bot owner detected");
    } catch (err) {
      logger.warn({ err }, "Could not fetch bot owner");
    }

    const rest = new REST({ version: "10" }).setToken(token);
    try {
      const guilds = await c.guilds.fetch();
      for (const [guildId] of guilds) {
        await rest.put(Routes.applicationGuildCommands(c.user.id, guildId), {
          body: commands.map((cmd) => cmd.toJSON()),
        });
      }
      logger.info("Slash commands registered");
    } catch (err) {
      logger.error({ err }, "Failed to register slash commands");
    }

    cron.schedule("*/5 * * * *", () => {
      postDeals(client).catch((err) => logger.error({ err }, "Cron deal check failed"));
    });

    // Proaktiver Token-Refresh alle 20 Minuten — hält Session frisch
    cron.schedule("*/20 * * * *", () => {
      ensureSession()
        .then((ok) => logger.info({ ok }, "Proactive session refresh"))
        .catch((err) => logger.warn({ err }, "Proactive session refresh failed"));
    });

    await postDeals(client);
  });

  // ─── Token per DM empfangen ────────────────────────────────────────────────
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    // Nur DMs akzeptieren
    if (message.channel.type !== 1) return; // 1 = DM_CHANNEL
    // Nur vom Bot-Owner
    if (botOwnerId && message.author.id !== botOwnerId) {
      await message.reply("❌ Du bist nicht berechtigt, den Token zu setzen.");
      return;
    }

    const content = message.content.trim();
    // Token ist lang (meist 100+ Zeichen) und enthält keine Leerzeichen
    if (content.length > 30 && !content.includes(" ")) {
      setManualToken(content);
      await message.reply(
        "✅ **Token gesetzt!** Der Bot startet jetzt sofort die Deal-Suche.\n" +
        "Der Token gilt ca. **12 Stunden** — ich melde mich wieder wenn er abläuft.",
      );
      logger.info("Token set via DM");
      setTimeout(() => postDeals(client).catch(() => {}), 1000);
    } else {
      await message.reply(
        "❓ Das sieht nicht wie ein gültiger Token aus.\n\n" +
        "Schick mir nur den `access_token_web` Wert aus den Vinted-Cookies — ohne Anführungszeichen, ohne Leerzeichen.",
      );
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    // ─── Button Handler ──────────────────────────────────────────────────────
    if (interaction.isButton()) {
      const { customId, user } = interaction;

      if (customId.startsWith("interested_")) {
        try {
          await interaction.message.react("👍");
          await interaction.reply({ content: "👍 Als interessant markiert!", ephemeral: true });
        } catch {
          await interaction.reply({ content: "❌ Fehler beim Reagieren.", ephemeral: true });
        }
        return;
      }

      if (customId.startsWith("fakecheck_")) {
        await interaction.deferReply({ ephemeral: true });
        const itemId = customId.replace("fakecheck_", "");
        const item = itemCache.get(itemId);

        if (!item) {
          await interaction.editReply("❌ Item nicht mehr im Cache (zu alt). Bitte nutze einen neueren Deal.");
          return;
        }

        const { embed, row } = runFakeCheck(item);

        // DM an User
        try {
          const dm = await user.createDM();
          await dm.send({
            content: `🔍 **Dein Fake-Check für einen Deal aus dem Server:**`,
            embeds: [embed],
            components: [row],
          });
          await interaction.editReply("✅ Fake-Check wurde dir per DM geschickt!");
        } catch {
          // Falls DMs deaktiviert → in #fake-check oder als ephemeral
          const fakeChannel = await findChannelByName(client, "fake-check");
          if (fakeChannel) {
            await fakeChannel.send({ content: `Fake-Check angefragt von <@${user.id}>:`, embeds: [embed], components: [row] });
            await interaction.editReply(`✅ Fake-Check in ${fakeChannel} gepostet (DMs sind deaktiviert).`);
          } else {
            await interaction.editReply({ embeds: [embed], components: [row] });
          }
        }
        return;
      }

      if (customId.startsWith("pricecheck_")) {
        await interaction.deferReply({ ephemeral: true });
        const itemId = customId.replace("pricecheck_", "");
        const item = itemCache.get(itemId);

        if (!item) {
          await interaction.editReply("❌ Item nicht mehr im Cache (zu alt). Bitte nutze einen neueren Deal.");
          return;
        }

        // Session sicherstellen bevor Vinted-Suche
        const sessionOk = await ensureSession();
        if (!sessionOk) {
          await interaction.editReply("⚠️ Vinted-Session gerade nicht verfügbar. Bitte in 1-2 Minuten nochmal versuchen.");
          return;
        }

        const alternatives = await findCheaperAlternatives(item);

        const mainEmbed = new EmbedBuilder()
          .setColor(0x09b1ba)
          .setTitle(`💰 Pricecheck: ${item.brand || ""} | ${item.title}`.slice(0, 250))
          .setURL(item.url)
          .setDescription(`**Dein Inserat:** ${item.price.toFixed(2)} ${item.currency} • ${item.size || "—"} • ${item.condition || "—"}`)
          .setFooter({ text: "Pricecheck • Snipebot" })
          .setTimestamp();
        if (item.imageUrl) mainEmbed.setThumbnail(item.imageUrl);

        const allEmbeds = [mainEmbed];
        const allRows: ActionRowBuilder<ButtonBuilder>[] = [];

        if (alternatives.length === 0) {
          mainEmbed.addFields({ name: "🔍 Ergebnis", value: "✅ Kein günstigeres Angebot gefunden — das ist schon ein guter Preis!" });
        } else {
          mainEmbed.addFields({ name: `🔍 ${alternatives.length} günstigere Alternative(n) gefunden`, value: "Die besten Alternativen siehst du unten:" });

          for (const [i, alt] of alternatives.slice(0, 3).entries()) {
            const savings = item.price - alt.price;
            allEmbeds.push(
              new EmbedBuilder()
                .setColor(0x00cc66)
                .setTitle(`#${i + 1} ${alt.brand || "—"} | ${alt.title}`.slice(0, 250))
                .setURL(alt.url)
                .addFields(
                  { name: "💰 Preis", value: `**${alt.price.toFixed(2)} ${alt.currency}**`, inline: true },
                  { name: "💸 Ersparnis", value: `**-${savings.toFixed(2)} EUR**`, inline: true },
                  { name: "📐 Größe", value: alt.size || "—", inline: true },
                  { name: "✨ Zustand", value: alt.condition || "—", inline: true },
                  { name: "👤 Verkäufer", value: alt.seller || "—", inline: true },
                )
                .setThumbnail(alt.imageUrl),
            );
            allRows.push(
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setLabel(`#${i + 1} Ansehen`).setStyle(ButtonStyle.Link).setURL(alt.url),
              ),
            );
          }
        }

        // DM an User
        try {
          const dm = await user.createDM();
          await dm.send({ content: `💰 **Dein Pricecheck aus dem Server:**`, embeds: allEmbeds, components: allRows });
          await interaction.editReply("✅ Pricecheck wurde dir per DM geschickt!");
        } catch {
          const priceChannel = await findChannelByName(client, "pricecheck");
          if (priceChannel) {
            await priceChannel.send({ content: `Pricecheck angefragt von <@${user.id}>:`, embeds: allEmbeds, components: allRows });
            await interaction.editReply(`✅ Pricecheck in ${priceChannel} gepostet (DMs sind deaktiviert).`);
          } else {
            await interaction.editReply({ embeds: allEmbeds, components: allRows });
          }
        }
        return;
      }

      if (customId.startsWith("save_")) {
        await interaction.deferReply({ ephemeral: true });
        const itemId = customId.replace("save_", "");
        const item = itemCache.get(itemId);

        if (!item) {
          await interaction.editReply("❌ Item nicht mehr im Cache (zu alt). Bitte nutze einen neueren Deal.");
          return;
        }

        const savedEmbed = new EmbedBuilder()
          .setColor(0xe91e63)
          .setTitle(`❤️ Gemerkter Deal: ${item.brand || ""} | ${item.title}`.slice(0, 250))
          .setURL(item.url)
          .addFields(
            { name: "💰 Preis", value: `**${item.price.toFixed(2)} ${item.currency}**`, inline: true },
            { name: "📐 Größe", value: item.size || "—", inline: true },
            { name: "✨ Zustand", value: item.condition || "—", inline: true },
            { name: "👤 Verkäufer", value: item.seller || "—", inline: true },
          )
          .setFooter({ text: "Deine gemerkten Deals • Snipebot" })
          .setTimestamp();
        if (item.imageUrl) savedEmbed.setImage(item.imageUrl);

        const linkRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setLabel("🛒 Auf Vinted ansehen").setStyle(ButtonStyle.Link).setURL(item.url),
          new ButtonBuilder().setLabel("💬 Verkäufer anschreiben").setStyle(ButtonStyle.Link).setURL(`${item.url}#message`),
        );

        try {
          const dm = await user.createDM();
          await dm.send({
            content: `❤️ **Du hast dir einen Deal gemerkt!**`,
            embeds: [savedEmbed],
            components: [linkRow],
          });
          await interaction.editReply("✅ Deal wurde dir per DM gemerkt!");
        } catch {
          await interaction.editReply({
            content: "⚠️ Deine DMs sind deaktiviert. Aktiviere DMs vom Server damit Deals gespeichert werden können.",
          });
        }
        return;
      }

      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction as ChatInputCommandInteraction;

    // ─── Lizenz prüfen ───────────────────────────────────────────────────────
    const guildId = cmd.guildId;
    if (guildId && WHOP_API_KEY && WHOP_PRODUCT_ID) {
      const licensed = await isGuildLicensed(guildId);
      if (!licensed) {
        await cmd.reply({
          content: "❌ **Kein aktives Abonnement!**\nDieser Bot ist nur für Premium-Mitglieder.\n👉 Kaufe eine Lizenz: https://whop.com",
          ephemeral: true,
        });
        return;
      }
    }

    try {
      if (cmd.commandName === "deals") {
        const sub = cmd.options.getSubcommand();

        if (sub === "start") {
          await cmd.deferReply();
          watchConfig.active = true;
          await cmd.editReply("✅ Deal-Suche gestartet! Suche jetzt...");
          await postDeals(client);
          await cmd.followUp("✅ Erste Suche abgeschlossen!");

        } else if (sub === "stop") {
          watchConfig.active = false;
          await cmd.reply("⏹️ Deal-Suche gestoppt.");

        } else if (sub === "status") {
          const catLabel = watchConfig.categoryKey === "alle"
            ? "Alle Kategorien (jede in eigenem Kanal)"
            : CATEGORIES[watchConfig.categoryKey]?.label ?? "Unbekannt";
          await cmd.reply(
            `📊 **Status**\n` +
            `• Aktiv: ${watchConfig.active ? "✅ Ja" : "❌ Nein"}\n` +
            `• Marken: ${watchConfig.brands.join(", ")}\n` +
            `• Kategorie: **${catLabel}**\n` +
            `• Geschlecht: **${genderLabel(watchConfig.gender)}**\n` +
            `• Max. Preis: ${watchConfig.maxPrice ? `${watchConfig.maxPrice} EUR` : "kein Limit"}\n` +
            `• Items im Cache: ${seenItemIds.size} (${itemCache.size} im Speicher)`,
          );

        } else if (sub === "marken") {
          const liste = cmd.options.getString("liste", true);
          watchConfig.brands = liste.split(",").map((b) => b.trim()).filter(Boolean);
          seenItemIds.clear();
          await cmd.reply(`✅ Marken aktualisiert: **${watchConfig.brands.join(", ")}**`);

        } else if (sub === "maxpreis") {
          const preis = cmd.options.getInteger("preis", true);
          watchConfig.maxPrice = preis > 0 ? preis : undefined;
          seenItemIds.clear();
          await cmd.reply(`✅ Max. Preis: ${preis > 0 ? `**${preis} EUR**` : "**kein Limit**"}`);

        } else if (sub === "kategorie") {
          const typ = cmd.options.getString("typ", true);
          if (typ !== "alle" && !CATEGORIES[typ]) { await cmd.reply("❌ Unbekannte Kategorie."); return; }
          watchConfig.categoryKey = typ;
          seenItemIds.clear();
          const label = typ === "alle"
            ? "Alle Kategorien (jede in eigenem Kanal)"
            : `**${CATEGORIES[typ]!.label}** → #${CATEGORIES[typ]!.channelName}`;
          await cmd.reply(`✅ Kategorie gesetzt: ${label}`);

        } else if (sub === "geschlecht") {
          const typ = cmd.options.getString("typ", true) as Gender;
          watchConfig.gender = typ;
          seenItemIds.clear();
          await cmd.reply(`✅ Geschlecht gesetzt: **${genderLabel(typ)}**`);

        } else if (sub === "suche") {
          await cmd.deferReply();
          await postDeals(client);
          await cmd.editReply("✅ Suche abgeschlossen!");

        } else if (sub === "reset") {
          seenItemIds.clear();
          itemCache.clear();
          await cmd.reply("🗑️ Cache geleert. Bei nächster Suche werden alle Items wieder als 'neu' behandelt.");

        } else if (sub === "token") {
          const tokenValue = cmd.options.getString("wert", true).trim();
          setManualToken(tokenValue);
          await cmd.reply({ content: "✅ Vinted Token gesetzt und gespeichert! Der Bot versucht nun sofort zu suchen.", ephemeral: true });
          // Trigger an immediate scan with the new token
          setTimeout(() => postDeals(client).catch(() => {}), 1000);
        }

      } else if (cmd.commandName === "lizenz") {
        if (!WHOP_API_KEY || !WHOP_PRODUCT_ID) {
          await cmd.reply({ content: "ℹ️ Whop ist noch nicht konfiguriert — Bot läuft im freien Modus.", ephemeral: true });
          return;
        }
        const licensed = guildId ? await isGuildLicensed(guildId) : false;
        await cmd.reply({
          content: licensed
            ? "✅ **Lizenz aktiv!** Dieser Server hat ein gültiges Premium-Abonnement."
            : "❌ **Keine Lizenz!** Kaufe eine Lizenz unter: https://whop.com",
          ephemeral: true,
        });
      }

    } catch (err) {
      logger.error({ err, command: cmd.commandName }, "Error handling slash command");
      try {
        const msg = { content: "❌ Fehler beim Verarbeiten des Befehls.", ephemeral: true };
        if (cmd.deferred || cmd.replied) await cmd.followUp(msg);
        else await cmd.reply(msg);
      } catch { /* ignore */ }
    }
  });

  client.on(Events.Error, (err) => { logger.error({ err }, "Discord client error"); });
  client.on(Events.ShardDisconnect, (event, shardId) => { logger.warn({ shardId, code: event.code }, "Discord shard disconnected"); });
  client.on(Events.ShardReconnecting, (shardId) => { logger.info({ shardId }, "Discord shard reconnecting"); });
  client.on(Events.ShardResume, (shardId) => { logger.info({ shardId }, "Discord shard resumed"); });

  await client.login(token);
}
