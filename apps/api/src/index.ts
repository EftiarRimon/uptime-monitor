import "dotenv/config";
import { createApp } from "./app.js";
import { initDatabase } from "./db.js";

const app = createApp();
const port = process.env.PORT ?? 3000;
app.listen(port, async () => {
  console.log(`API listening on port ${port}`);
  try {
    await initDatabase();
    console.log("Database ready");
  } catch {
    console.error(
      "Database unavailable; API will continue serving health checks",
    );
  }
});
