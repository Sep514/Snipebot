import { startBot } from "./discordbot.js";

startBot().catch((err) => {
  console.error("Fatal error starting bot:", err);
  process.exit(1);
});
