import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".opencara");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
/** Durable agent conversations, one SQLite file each (runner/conversations.ts). */
export const CONVERSATIONS_DIR = join(CONFIG_DIR, "conversations");

export const DEFAULT_ORCHESTRATOR_URL = "https://opencara.com";
