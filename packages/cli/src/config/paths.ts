import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".openkira");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export const DEFAULT_ORCHESTRATOR_URL = "https://openkira.com";
