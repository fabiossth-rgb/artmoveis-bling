/**
 * Art Móveis × XML Feed — Backend
 * Produtos via XML público da Tray + Checkout Mercado Pago
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
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "APP_USR-4650107760827637-032712-e385940e3d8d25df9502d0ee92e5518b-1605928811";
const MP_API = "https://api.mercadopago.com";
const BACKEND_URL = process.env.BACKEND_URL || "https://artmoveis-bling-1.onrender.com";

// ─── CACHE ────────────────────────────────────────────────────────────────────
let cache = { produtos: [], updatedAt: null };

// ─── PEDIDOS EM MEMÓRIA (futuramente: banco de dados) ─────────────────────────
const pedidos = new Map();

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

  let items = [];
  if (json?.rss?.channel?.item) {
    items = Array.isArray(json.rss.channel.item) ? json.rss.channel.item : [json.rss.channel.item];
  } else if (json?.feed?.entry) {
    items = Array.isArray(json.feed.entry) ? json.feed.entry : [json.feed.entry];
  } else if (json?.produtos?.produto) {
    items = Array.isArray(json.produtos.produto) ? json.produtos.produto : [json.produtos.produto];
  }

  console.log(`XML: ${items.length} itens encontrados`);

  cache.produtos = items.map((item, idx) => {
    const title = item["g:title"] || item.title || item.nome || `Produto ${idx}`;
    const price = parsePreco(item["g:sale_price"] || item["g:price"] || item.price || item.preco);
    const oldPrice = parsePreco(item["g:price"] || item.price || item.preco) || price * 1.35;
    const image = item["g:image_link"] || item.image || item.imagem || FALLBACK;
    const link = item["g:link"] || item.link || item.url || "";
    const category = item["g:product_type"] || item["g:google_product_category"] || item.category || item.categoria || "Geral";
    const desc = item["g:description"] || item.description || item.descricao || "";
    const id = item["g:id"] || item.id || String(idx + 1);
    const brand = item["g:brand"] || item.brand || item.marca || "Art Móveis";

    // Imagens adicionais
    const addImgs = item["g:additional_image_link"];
    let images = [image];
    if (addImgs) {
      if (Array.isArray(addImgs)) images = [image, ...addImgs];
      else images = [image, addImgs];
    }

    return {
      id, name: title, price, oldPrice: oldPrice > price ? oldPrice : price * 1.35,
      image, images: images.filter(Boolean), link, category, desc, brand,
      sold: Math.floor(Math.random() * 200) + 20,
      rating: +(4 + Math.random() * 0.9).toFixed(1),
    };
  });

  cache.updatedAt = new Date();
  console.log(`Cache atualizado: ${cache.produtos.length} produtos`);
}

// Carregar ao iniciar e refresh a cada 15 min
carregarXML().catch(e => console.error("Erro ao carregar XML:", e.message));
setInterval(() => carregarXML().catch(e => console.error("Refresh XML falhou:", e.message)), 15 * 60 * 1000);

// ─── ENDPOINTS PRODUTOS ───────────────────────────────────────────────────────
app.get("/produtos", (_, res) => {
  res.json({ ok: true, produtos: cache.produtos, total: cache.produtos.length, updatedAt: cache.updatedAt });
});

app.get("/produtos/:id", (req, res) => {
  const p = cache.produtos.find(x => String(x.id) === String(req.params.id));
  if (!p) return res.status(404).json({ ok: false, erro: "Produto não encontrado" });
  res.json({ ok: true, ...p });
});

app.post("/cache/refresh", async (_, res) => {
  try {
    await carregarXML();
    res.json({ ok: true, total: cache.produtos.length });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ─── MERCADO PAGO — CRIAR PREFERÊNCIA DE PAGAMENTO ────────────────────────────
app.post("/checkout/mp", async (req, res) => {
  try {
    const { items, payer, shipping_cost = 0, seller_code } = req.body;

    if (!items || !items.length) {
      return res.status(400).json({ ok: false, erro: "Nenhum item no carrinho" });
    }

    // Montar itens pra API do MP
    const mpItems = items.map(item => ({
      id: String(item.id),
      title: String(item.name).substring(0, 256),
      description: String(item.desc || item.name).substring(0, 256),
      picture_url: item.image || FALLBACK,
      category_id: "home",
      quantity: Number(item.qty) || 1,
      currency_id: "BRL",
      unit_price: Number(Number(item.price).toFixed(2)),
    }));

    // Adicionar frete como item se > 0
    if (shipping_cost > 0) {
      mpItems.push({
        id: "frete",
        title: "Frete — Entrega Ceará",
        quantity: 1,
        currency_id: "BRL",
        unit_price: Number(Number(shipping_cost).toFixed(2)),
      });
    }

    // ID interno do pedido
    const orderId = `ART-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;

    const preference = {
      items: mpItems,
      payer: payer ? {
        name: payer.name || "",
        email: payer.email || "",
        phone: payer.phone ? { number: payer.phone } : undefined,
      } : undefined,
      back_urls: {
        success: `${BACKEND_URL}/checkout/retorno?status=approved&order=${orderId}`,
        failure: `${BACKEND_URL}/checkout/retorno?status=rejected&order=${orderId}`,
        pending: `${BACKEND_URL}/checkout/retorno?status=pending&order=${orderId}`,
      },
      auto_return: "approved",
      external_reference: orderId,
      notification_url: `${BACKEND_URL}/webhook/mp`,
      statement_descriptor: "ART MOVEIS",
      payment_methods: {
        excluded_payment_types: [],
        installments: 12,
      },
      metadata: {
        seller_code: seller_code || null,
        app: "artmoveis-app",
      },
    };

    console.log(`[MP] Criando preferência: ${orderId} — ${mpItems.length} itens`);

    const { data } = await axios.post(`${MP_API}/checkout/preferences`, preference, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${MP_ACCESS_TOKEN}`,
      },
    });

    // Salvar pedido localmente
    pedidos.set(orderId, {
      id: orderId,
      mp_preference_id: data.id,
      items,
      payer,
      shipping_cost,
      seller_code,
      status: "pending",
      created_at: new Date().toISOString(),
      total: mpItems.reduce((s, i) => s + i.unit_price * i.quantity, 0),
    });

    console.log(`[MP] Preferência criada: ${data.id} → ${data.init_point}`);

    res.json({
      ok: true,
      order_id: orderId,
      preference_id: data.id,
      checkout_url: data.init_point,        // URL do checkout MP (produção)
      sandbox_url: data.sandbox_init_point,  // URL sandbox (pra testes)
    });

  } catch (e) {
    console.error("[MP] Erro:", e.response?.data || e.message);
    res.status(500).json({
      ok: false,
      erro: "Erro ao criar checkout",
      detalhes: e.response?.data?.message || e.message,
    });
  }
});

// ─── MERCADO PAGO — WEBHOOK DE NOTIFICAÇÃO ────────────────────────────────────
app.post("/webhook/mp", async (req, res) => {
  try {
    const { type, data } = req.body;
    console.log(`[MP Webhook] Tipo: ${type}, ID: ${data?.id}`);

    if (type === "payment") {
      // Buscar detalhes do pagamento
      const { data: payment } = await axios.get(`${MP_API}/v1/payments/${data.id}`, {
        headers: { "Authorization": `Bearer ${MP_ACCESS_TOKEN}` },
      });

      const orderId = payment.external_reference;
      const status = payment.status; // approved, pending, rejected, etc

      console.log(`[MP Webhook] Pedido ${orderId}: ${status} — R$ ${payment.transaction_amount}`);

      // Atualizar pedido local
      if (pedidos.has(orderId)) {
        const pedido = pedidos.get(orderId);
        pedido.status = status;
        pedido.mp_payment_id = data.id;
        pedido.mp_status = status;
        pedido.mp_status_detail = payment.status_detail;
        pedido.paid_at = payment.date_approved || null;
        pedido.payment_method = payment.payment_method_id;
        pedidos.set(orderId, pedido);
      }

      // TODO: Quando tiver API da Tray, criar pedido lá
      // if (status === "approved") { await criarPedidoTray(pedido); }
    }

    res.status(200).send("OK");
  } catch (e) {
    console.error("[MP Webhook] Erro:", e.message);
    res.status(200).send("OK"); // Sempre 200 pra MP não reenviar
  }
});

// ─── PÁGINA DE RETORNO APÓS PAGAMENTO ─────────────────────────────────────────
app.get("/checkout/retorno", (req, res) => {
  const { status, order } = req.query;
  // Redireciona de volta pro app com status
  const appUrl = process.env.APP_URL || "https://artmoveis-app.vercel.app";
  res.redirect(`${appUrl}?payment_status=${status}&order=${order}`);
});

// ─── CONSULTAR STATUS DO PEDIDO ───────────────────────────────────────────────
app.get("/pedido/:id", (req, res) => {
  const pedido = pedidos.get(req.params.id);
  if (!pedido) return res.status(404).json({ ok: false, erro: "Pedido não encontrado" });
  res.json({ ok: true, ...pedido });
});

// ─── LISTAR PEDIDOS (admin) ───────────────────────────────────────────────────
app.get("/pedidos", (_, res) => {
  const lista = Array.from(pedidos.values()).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ ok: true, pedidos: lista, total: lista.length });
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({
  status: "online",
  autenticado: true,
  fonte: "XML",
  cachedProducts: cache.produtos.length,
  mp_configured: !!MP_ACCESS_TOKEN,
  pedidos_count: pedidos.size,
  updatedAt: cache.updatedAt,
}));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Art Móveis × MP rodando na porta ${PORT}`);
});
