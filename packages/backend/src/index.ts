import { app } from "./server";
import { db } from "./db/connection";
import { runMigrations } from "./db/migrations";

runMigrations(db);

const PORT = parseInt(process.env.PORT || "4888", 10);

app.listen(PORT, () => {
  console.log(`[trickle] Backend listening on http://localhost:${PORT}`);
});
