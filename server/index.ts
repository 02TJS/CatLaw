import "dotenv/config";
import path from "node:path";
import { createCatWorkshopApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
const webDist = path.resolve(process.cwd(), process.env.WEB_DIST ?? "dist");
const app = createCatWorkshopApp({ webDist, apiKey: process.env.DEEPSEEK_API_KEY });

app.listen(port, "127.0.0.1", () => {
  console.log(`Cat Workshop API listening on http://127.0.0.1:${port}`);
});
