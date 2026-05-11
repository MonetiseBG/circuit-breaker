import type { Logger } from "./types.js";

export const defaultLogger: Logger = (message) => {
  // eslint-disable-next-line no-console
  console.warn(`[circuit-breaker] ${message}`);
};
