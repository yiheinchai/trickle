import path from "path";
import fs from "fs";
import Database, { Database as DatabaseType } from "better-sqlite3";

const trickleDir = path.join(process.env.HOME || "~", ".trickle");

fs.mkdirSync(trickleDir, { recursive: true });

const dbPath = path.join(trickleDir, "trickle.db");

const db: DatabaseType = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export { db };
