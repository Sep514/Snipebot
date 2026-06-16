import { startBot } from './discordbot.js';
import { logger } from './lib/logger.js';

function main() {
  logger.info('Starte Snipebot Anwendung...');
  try {
    startBot();
  } catch (error) {
    logger.error('Fataler Fehler bei der Bot-Initialisierung:', error);
    process.exit(1);
  }
}

main();