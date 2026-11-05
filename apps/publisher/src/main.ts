import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");

import express from "express";
import { HexeraMerchant, hexeraPaywall, x402Cors } from "@hexera/server";
import { PUBLICATIONS } from "./content";

const id = process.env.PUBLISHER ?? "daily-ledger";
const pub = PUBLICATIONS[id];
if (!pub) throw new Error(`unknown PUBLISHER ${id}; one of ${Object.keys(PUBLICATIONS).join(", ")}`);
const port = Number(process.env.PORT ?? 4021);
const facilitatorUrl = process.env.FACILITATOR_URL ?? "http://localhost:4020";

const merchant = new HexeraMerchant({ facilitatorUrl, merchantId: pub.id, merchantName: pub.name, log: (m) => console.log(`[${pub.id}] ${m}`) });
const app = express();
app.set("trust proxy", true);
app.use(x402Cors());

// Free: the catalogue.
app.get("/", (_req, res) => {
  res.json({
    id: pub.id,
    name: pub.name,
    tagline: pub.tagline,
    articles: pub.articles.map(({ slug, title, teaser, price }) => ({ slug, title, teaser, price, url: `/articles/${slug}` })),
  });
});

// Paid: one route per article, each with its own price.
for (const a of pub.articles) {
  app.get(`/articles/${a.slug}`, hexeraPaywall(merchant, { price: a.price, description: `${pub.name}: ${a.title}` }), (_req, res) => {
    res.json({ publisher: pub.name, slug: a.slug, title: a.title, body: a.body, paid: { units: a.price, hcsTransaction: res.locals.hexera?.transaction } });
  });
}

app.listen(port, () => console.log(`[${pub.id}] "${pub.name}" on http://localhost:${port} (facilitator ${facilitatorUrl})`));
