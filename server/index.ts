import dotenv from "dotenv";
import path from "node:path";
import { createCatWorkshopApp } from "./app.js";

const dotenvPath = process.env.DOTENV_CONFIG_PATH?.trim();
dotenv.config(dotenvPath ? { path: dotenvPath, quiet: true } : { quiet: true });

const port = Number(process.env.PORT ?? 8787);
const webDist = path.resolve(process.cwd(), process.env.WEB_DIST ?? "dist");
const app = createCatWorkshopApp({
  webDist,
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseUrl: process.env.DEEPSEEK_BASE_URL,
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Cat Workshop API listening on http://127.0.0.1:${port}`);
});
