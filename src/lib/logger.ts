type LogData = Record<string, unknown>;

function formatMessage(level: string, dataOrMsg: LogData | string, msg?: string): string {
  const timestamp = new Date().toISOString();
  if (typeof dataOrMsg === "string") {
    return `[${timestamp}] ${level}: ${dataOrMsg}`;
  }
  const message = msg ?? "";
  const data = JSON.stringify(dataOrMsg);
  return `[${timestamp}] ${level}: ${message} ${data}`.trimEnd();
}

export const logger = {
  info(dataOrMsg: LogData | string, msg?: string): void {
    console.log(formatMessage("INFO", dataOrMsg, msg));
  },

  warn(dataOrMsg: LogData | string, msg?: string): void {
    console.warn(formatMessage("WARN", dataOrMsg, msg));
  },

  error(dataOrMsg: LogData | string, msg?: string): void {
    console.error(formatMessage("ERROR", dataOrMsg, msg));
  },
};
