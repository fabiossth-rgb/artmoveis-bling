/**
 * Art Móveis × XML Feed — Backend
 * Usa o XML público da loja como fonte de dados
 */

import express from "express";
import cors from "cors";
import axios from "axios";
import { XMLParser } from "fast-xml-parser";

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.options("*", cors());
app.use(express.json());

const XML_URL  = "https://www.lojasartmoveis.com.br/xml/xml.php?Chave=wav9mYlNWYmx3N0cDO0ITM";
const FALLBACK = "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400&q=80";

// ─── CACHE ────────────────────────────────────────────────────────────────────
let cache = { produtos: [], updatedAt: null };

function parsePreco(val) {
  if (!val) return 0;
  return parseFloat(String(val).replace(/[R$\s]/g, "").replace(/\./g, "").replace(",", ".")) || 0;
}

async function carregarXML() {
  console.log("Buscando XML...");
  const { data: raw } = await axios.get(XML_URL, {
    responseType: "text",
    timeout: 30000,
    headers: { "Accept": "application/xml, text/xml, */*" }
  });

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const json = parser.parse(raw);

  const rootKeys = Object.keys(json);
  console.log("Root keys:", rootKeys);

  let items = [];

  if (json?.rss?.channel?.item) {
    items = Array.isArray(json.rss.channel.item) ? json.rss.channel.item : [json.rss.channel.item];
    console.log("Formato: RSS/Google Shopping,", items.length, "itens");
  } else if (json?.feed?.entry) {
    items = Array.isArray(json.feed.entry) ? json.feed.entry : [json.feed.entry];
    console.log("Formato: Atom feed,", items.length, "itens");
  } else if (json?.produtos?.produto) {
    items = Array.isArray(json.produtos.produto) ? json.produtos.produto : [json.produtos.produto];
    console.log("Formato: Tray custom,", items.length, "itens");
  } else {
    for (const key of rootKeys) {
      const sub = json[key];
      if (sub && typeof sub === "object") {
        for (const k2 of Object.keys(sub)) {
          if (Array.isArray(sub[k2]) && sub[k2].length > 5) {
            items = sub[k2];
            console.log(`Formato desconhecido — usando ${key}.${k2},`, items.length, "itens");
            break;
          }
        }
      }
      if (items.length > 0) break;
    }
  }

  if (items.length === 0) {
    console.warn("Nenhum item encontrado. Estrutura:", JSON.stringify(json).slice(0, 500));
    return [];
  }

  const produtos = items.map((item, i) => {
    const name      = item["g:title"] || item.title || item.nome || item.name || `Produto ${i+1}`;
    const precoRaw  = item["g:price"] || item.price || item.preco || item["g:sale_price"] || "0";
    const promoRaw  = item["g:sale_price"] || item.promotional_price || item.preco_promocional || "0";
    const preco     = parsePreco(precoRaw);
    const promo     = parsePreco(promoRaw);
    const price     = promo > 0 && promo < preco ? promo : preco;
    const oldPrice  = promo > 0 && promo < preco ? preco : Math.round(preco * 1.35);
    const image     = item["g:image_link"] || item.image_link || item.imagem || item.image || FALLBACK;
    const category  = item["g:product_type"] || item.product_type || item.categoria || item.category || "Geral";
    const id        = item["g:id"] || item.id || item["g:item_group_id"] || String(i + 1);
    const desc      = item["g:description"] || item.description || item.descricao || name;

    return {
      id: String(id),
      name: String(name),
      category: String(category).split(">").pop().trim(),
      price,
      oldPrice,
      image: String(image),
      desc: String(desc).replace(/<[^>]*>/g, "").slice(0, 300),
      sold: Math.floor(Math.random() * 200) + 10,
      rating: +(4.4 + Math.random() * 0.6).toFixed(1),
      reviews: Math.floor(Math.random() * 80) + 5,
    };
  }).filter(p => p.price > 0);

  console.log(`XML processado: ${produtos.length} produtos com preço`);
  return produtos;
}

// ─── PRODUTOS ─────────────────────────────────────────────────────────────────
app.get("/produtos", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    if (cache.produtos.length > 0) {
      console.log(`Cache hit: ${cache.produtos.length} produtos`);
      return res.json({ ok: true, total: cache.produtos.length, produtos: cache.produtos });
    }
    const produtos = await carregarXML();
    cache.produtos = produtos;
    cache.updatedAt = new Date();
    res.json({ ok: true, total: produtos.length, produtos });
  } catch (e) {
    console.error("Erro /produtos:", e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.get("/produtos/:id", async (req, res) => {
  try {
    if (cache.produtos.length === 0) {
      const produtos = await carregarXML();
      cache.produtos = produtos;
    }
    const p = cache.produtos.find(x => String(x.id) === String(req.params.id));
    if (!p) return res.status(404).json({ ok: false, erro: "Não encontrado" });
    res.json({ ok: true, image: p.image, desc: p.desc });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.get("/debug/xml", async (req, res) => {
  try {
    const { data: raw } = await axios.get(XML_URL, { responseType: "text", timeout: 30000 });
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    const json = parser.parse(raw);
    res.json({ rootKeys: Object.keys(json), sample: JSON.stringify(json).slice(0, 3000) });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post("/cache/refresh", (req, res) => {
  cache = { produtos: [], updatedAt: null };
  res.json({ ok: true, msg: "Cache limpo" });
});

app.get("/auth/login", (_, res) => res.redirect("/health"));
app.get("/auth/status", (_, res) => res.json({ autenticado: true, tokenValido: true }));

app.post("/pedidos", async (req, res) => {
  try {
    const { items, total, payment, coupon } = req.body;
    console.log("Pedido:", { items, total, payment, coupon });
    res.json({ ok: true, mensagem: "Pedido registrado!" });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.get("/health", (_, res) => res.json({ status: "online", autenticado: true, fonte: "XML", cachedProducts: cache.produtos.length }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Art Moveis × XML rodando na porta ${PORT}`);
});
