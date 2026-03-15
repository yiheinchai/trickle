import path from "path";
import fs from "fs";
import Database, { Database as DatabaseType } from "better-sqlite3";

const dbPath = process.env.TRICKLE_DB_PATH || path.join(process.env.HOME || "~", ".trickle", "trickle.db");
const trickleDir = path.dirname(dbPath);

fs.mkdirSync(trickleDir, { recursive: true });

const db: DatabaseType = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export { db };
