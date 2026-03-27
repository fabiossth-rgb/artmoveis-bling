/**
 * Art Móveis × Backend v2
 * Produtos via XML Tray + Checkout Mercado Pago + Pedidos no Supabase
 */

import express from "express";
import cors from "cors";
import axios from "axios";
import { XMLParser } from "fast-xml-parser";
import crypto from "crypto";

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.options("*", cors());
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const XML_URL  = "https://www.lojasartmoveis.com.br/xml/xml.php?Chave=wav9mYlNWYmx3N0cDO0ITM";
const FALLBACK = "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400&q=80";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";
const MP_API = "https://api.mercadopago.com";
const BACKEND_URL = process.env.BACKEND_URL || "https://artmoveis-bling-1.onrender.com";

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || "https://gujrjkwbiwxtoogrpodz.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const sbHeaders = {
  "Content-Type": "application/json",
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Prefer": "return=representation",
};

const sb = {
  async insert(table, data) {
    const { data: res } = await axios.post(`${SUPABASE_URL}/rest/v1/${table}`, data, { headers: sbHeaders });
    return res;
  },
  async update(table, match, data) {
    const params = Object.entries(match).map(([k, v]) => `${k}=eq.${v}`).join("&");
    const { data: res } = await axios.patch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, data, { headers: sbHeaders });
    return res;
  },
  async select(table, query = "") {
    const { data: res } = await axios.get(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: { ...sbHeaders, "Prefer": "" } });
    return res;
  },
  async upsert(table, data) {
    const { data: res } = await axios.post(`${SUPABASE_URL}/rest/v1/${table}`, data, {
      headers: { ...sbHeaders, "Prefer": "return=representation,resolution=merge-duplicates" },
    });
    return res;
  },
};

// ─── CACHE XML ────────────────────────────────────────────────────────────────
let cache = { produtos: [], updatedAt: null };

function parsePreco(val) {
  if (!val) return 0;
  let s = String(val).replace(/[R$\sBRL]/g, "").trim();
  if (s.includes(",")) { s = s.replace(/\./g, "").replace(",", "."); }
  return parseFloat(s) || 0;
}

function decodeEntities(str) {
  if (!str || typeof str !== "string") return str || "";
  let s = str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  s = s.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
  return s;
}

function decodeCategory(str) {
  let s = decodeEntities(str);
  if (s.includes(">")) s = s.split(">")[0].trim();
  return s;
}

async function carregarXML() {
  console.log("Buscando XML...");
  const { data: raw } = await axios.get(XML_URL, { responseType: "text", timeout: 30000, headers: { "Accept": "application/xml, text/xml, */*" } });
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const json = parser.parse(raw);

  let items = [];
  if (json?.rss?.channel?.item) items = Array.isArray(json.rss.channel.item) ? json.rss.channel.item : [json.rss.channel.item];
  else if (json?.feed?.entry) items = Array.isArray(json.feed.entry) ? json.feed.entry : [json.feed.entry];
  else if (json?.produtos?.produto) items = Array.isArray(json.produtos.produto) ? json.produtos.produto : [json.produtos.produto];

  console.log(`XML: ${items.length} itens`);

  cache.produtos = items.map((item, idx) => {
    const title = decodeEntities(item["g:title"] || item.title || item.nome || `Produto ${idx}`);
    const price = parsePreco(item["g:sale_price"] || item["g:price"] || item.price || item.preco);
    const oldPrice = parsePreco(item["g:price"] || item.price || item.preco) || price * 1.35;
    const image = item["g:image_link"] || item.image || item.imagem || FALLBACK;
    const link = item["g:link"] || item.link || item.url || "";
    const category = decodeCategory(item["g:product_type"] || item["g:google_product_category"] || item.category || item.categoria || "Geral");
    const desc = decodeEntities(item["g:description"] || item.description || item.descricao || "");
    const id = item["g:id"] || item.id || String(idx + 1);
    const brand = decodeEntities(item["g:brand"] || item.brand || item.marca || "Art Móveis");
    const addImgs = item["g:additional_image_link"];
    let images = [image];
    if (addImgs) { if (Array.isArray(addImgs)) images = [image, ...addImgs]; else images = [image, addImgs]; }

    return { id, name: title, price, oldPrice: oldPrice > price ? oldPrice : price * 1.35, image, images: images.filter(Boolean), link, category, desc, brand, sold: Math.floor(Math.random() * 200) + 20, rating: +(4 + Math.random() * 0.9).toFixed(1) };
  });

  cache.updatedAt = new Date();
  console.log(`Cache: ${cache.produtos.length} produtos`);
}

carregarXML().catch(e => console.error("Erro XML:", e.message));
setInterval(() => carregarXML().catch(e => console.error("Refresh XML falhou:", e.message)), 15 * 60 * 1000);

// ─── ENDPOINTS PRODUTOS ───────────────────────────────────────────────────────
app.get("/produtos", (_, res) => res.json({ ok: true, produtos: cache.produtos, total: cache.produtos.length, updatedAt: cache.updatedAt }));
app.get("/produtos/:id", (req, res) => {
  const p = cache.produtos.find(x => String(x.id) === String(req.params.id));
  if (!p) return res.status(404).json({ ok: false, erro: "Produto não encontrado" });
  res.json({ ok: true, ...p });
});
app.post("/cache/refresh", async (_, res) => {
  try { await carregarXML(); res.json({ ok: true, total: cache.produtos.length }); }
  catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── MERCADO PAGO — CRIAR PREFERÊNCIA ─────────────────────────────────────────
app.post("/checkout/mp", async (req, res) => {
  try {
    const { items, payer, shipping_cost = 0, seller_code } = req.body;
    if (!items || !items.length) return res.status(400).json({ ok: false, erro: "Carrinho vazio" });

    const mpItems = items.map(item => ({
      id: String(item.id), title: String(item.name).substring(0, 256),
      description: String(item.desc || item.name).substring(0, 256),
      picture_url: item.image || FALLBACK, category_id: "home",
      quantity: Number(item.qty) || 1, currency_id: "BRL",
      unit_price: Number(Number(item.price).toFixed(2)),
    }));

    if (shipping_cost > 0) {
      mpItems.push({ id: "frete", title: "Frete — Entrega Ceará", quantity: 1, currency_id: "BRL", unit_price: Number(Number(shipping_cost).toFixed(2)) });
    }

    const orderId = `ART-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const total = mpItems.reduce((s, i) => s + i.unit_price * i.quantity, 0);

    const preference = {
      items: mpItems,
      payer: payer ? { name: payer.name || "", email: payer.email || "", phone: payer.phone ? { number: payer.phone } : undefined } : undefined,
      back_urls: {
        success: `${BACKEND_URL}/checkout/retorno?status=approved&order=${orderId}`,
        failure: `${BACKEND_URL}/checkout/retorno?status=rejected&order=${orderId}`,
        pending: `${BACKEND_URL}/checkout/retorno?status=pending&order=${orderId}`,
      },
      auto_return: "approved", external_reference: orderId,
      notification_url: `${BACKEND_URL}/webhook/mp`,
      statement_descriptor: "ART MOVEIS",
      payment_methods: { excluded_payment_types: [], installments: 12 },
      metadata: { seller_code: seller_code || null, app: "artmoveis-app" },
    };

    console.log(`[MP] Criando: ${orderId}`);
    console.log("🕵️ Espião do Token:", MP_ACCESS_TOKEN ? `Tamanho: ${MP_ACCESS_TOKEN.length} | Início: ${MP_ACCESS_TOKEN.substring(0, 10)}...` : "⚠️ VAZIO OU INDEFINIDO");
    const { data } = await axios.post(`${MP_API}/checkout/preferences`, preference, {
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${MP_ACCESS_TOKEN}` },
    });

    // Salvar no Supabase
    try {
      if (payer?.email) {
        await sb.upsert("clientes", { email: payer.email, nome: payer.name || "", telefone: payer.phone || "" });
      }
      await sb.insert("pedidos", {
        id: orderId, cliente_nome: payer?.name || null, cliente_email: payer?.email || null,
        cliente_telefone: payer?.phone || null, items: JSON.stringify(items),
        subtotal: total - shipping_cost, frete: shipping_cost, total,
        status: "pending", mp_preference_id: data.id, seller_code: seller_code || null,
      });
      console.log(`[DB] Pedido ${orderId} salvo`);
    } catch (dbErr) {
      console.error("[DB] Erro:", dbErr.response?.data || dbErr.message);
    }

    res.json({ ok: true, order_id: orderId, preference_id: data.id, checkout_url: data.init_point, sandbox_url: data.sandbox_init_point });

  } catch (e) {
    console.error("[MP] Erro:", e.response?.data || e.message);
    res.status(500).json({ ok: false, erro: "Erro ao criar checkout", detalhes: e.response?.data?.message || e.message });
  }
});

// ─── WEBHOOK MP ───────────────────────────────────────────────────────────────
app.post("/webhook/mp", async (req, res) => {
  try {
    const { type, data } = req.body;
    console.log(`[Webhook] ${type} — ${data?.id}`);

    if (type === "payment") {
      const { data: payment } = await axios.get(`${MP_API}/v1/payments/${data.id}`, {
        headers: { "Authorization": `Bearer ${MP_ACCESS_TOKEN}` },
      });
      const orderId = payment.external_reference;
      const status = payment.status;
      console.log(`[Webhook] ${orderId}: ${status} R$ ${payment.transaction_amount}`);

      try {
        await sb.update("pedidos", { id: orderId }, {
          status, mp_payment_id: String(data.id), mp_status: status,
          mp_status_detail: payment.status_detail || null,
          paid_at: payment.date_approved || null,
          payment_method: payment.payment_method_id || null,
        });
        console.log(`[DB] ${orderId} → ${status}`);
      } catch (dbErr) {
        console.error("[DB] Erro update:", dbErr.response?.data || dbErr.message);
      }
    }
    res.status(200).send("OK");
  } catch (e) {
    console.error("[Webhook] Erro:", e.message);
    res.status(200).send("OK");
  }
});

// ─── RETORNO ──────────────────────────────────────────────────────────────────
app.get("/checkout/retorno", (req, res) => {
  const { status, order } = req.query;
  const appUrl = process.env.APP_URL || "https://artmoveis-app.vercel.app";
  res.redirect(`${appUrl}?payment_status=${status}&order=${order}`);
});

// ─── PEDIDOS — CONSULTAS ──────────────────────────────────────────────────────
app.get("/pedido/:id", async (req, res) => {
  try {
    const rows = await sb.select("pedidos", `id=eq.${req.params.id}`);
    if (!rows?.length) return res.status(404).json({ ok: false, erro: "Pedido não encontrado" });
    const p = rows[0]; if (typeof p.items === "string") p.items = JSON.parse(p.items);
    res.json({ ok: true, ...p });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get("/pedidos/cliente/:email", async (req, res) => {
  try {
    const rows = await sb.select("pedidos", `cliente_email=eq.${encodeURIComponent(req.params.email)}&order=created_at.desc&limit=50`);
    const pedidos = (rows || []).map(p => { if (typeof p.items === "string") p.items = JSON.parse(p.items); return p; });
    res.json({ ok: true, pedidos, total: pedidos.length });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get("/pedidos", async (req, res) => {
  try {
    const limit = req.query.limit || 100;
    const status = req.query.status;
    let query = `order=created_at.desc&limit=${limit}`;
    if (status) query += `&status=eq.${status}`;
    const rows = await sb.select("pedidos", query);
    const pedidos = (rows || []).map(p => { if (typeof p.items === "string") p.items = JSON.parse(p.items); return p; });
    res.json({ ok: true, pedidos, total: pedidos.length });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({
  status: "online", autenticado: true, fonte: "XML",
  cachedProducts: cache.produtos.length,
  mp: !!MP_ACCESS_TOKEN, supabase: !!SUPABASE_KEY,
  updatedAt: cache.updatedAt,
}));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Art Móveis v2 — porta ${PORT}`);
  console.log(`Supabase: ${SUPABASE_KEY ? "OK" : "SEM CHAVE"} | MP: ${MP_ACCESS_TOKEN ? "OK" : "SEM TOKEN"}`);
});
