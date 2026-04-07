/**
 * Art Móveis × Backend v2
 * Produtos via XML Tray + Checkout Mercado Pago + Pedidos no Supabase
 */

import express from "express";
import cors from "cors";
import axios from "axios";
import { XMLParser } from "fast-xml-parser";
import crypto from "crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.options("*", cors());
app.use(express.json({ limit: "10mb" }));

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
  async delete(table, match) {
    const params = Object.entries(match).map(([k, v]) => `${k}=eq.${v}`).join("&");
    const { data: res } = await axios.delete(`${SUPABASE_URL}/rest/v1/${table}?${params}`, { headers: sbHeaders });
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

    const availability = (item["g:availability"] || item.availability || "in stock").toLowerCase().trim();
    const inStock = availability === "in stock";

    return { id, name: title, price, oldPrice: oldPrice > price ? oldPrice : price * 1.35, image, images: images.filter(Boolean), link, category, desc, brand, inStock, sold: Math.floor(Math.random() * 200) + 20, rating: +(4 + Math.random() * 0.9).toFixed(1) };
  });

  const total = cache.produtos.length;
  const outOfStock = cache.produtos.filter(p => !p.inStock).length;
  cache.updatedAt = new Date();
  console.log(`Cache: ${total} produtos (${outOfStock} fora de estoque)`);
}

carregarXML().catch(e => console.error("Erro XML:", e.message));
setInterval(() => carregarXML().catch(e => console.error("Refresh XML falhou:", e.message)), 15 * 60 * 1000);

// ─── ENDPOINTS PRODUTOS ───────────────────────────────────────────────────────
app.get("/produtos", (_, res) => res.json({ ok: true, produtos: cache.produtos, total: cache.produtos.length, updatedAt: cache.updatedAt }));
app.get("/debug-xml-fields", async (_, res) => {
  try {
    const { data: raw } = await axios.get(XML_URL, { responseType: "text", timeout: 30000, headers: { "Accept": "application/xml, text/xml, */*" } });
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    const json = parser.parse(raw);
    let items = [];
    if (json?.rss?.channel?.item) items = Array.isArray(json.rss.channel.item) ? json.rss.channel.item : [json.rss.channel.item];
    else if (json?.feed?.entry) items = Array.isArray(json.feed.entry) ? json.feed.entry : [json.feed.entry];
    else if (json?.produtos?.produto) items = Array.isArray(json.produtos.produto) ? json.produtos.produto : [json.produtos.produto];
    const sample = items.slice(0, 2).map(i => Object.keys(i).reduce((o, k) => { o[k] = typeof i[k] === "string" ? i[k].substring(0, 100) : i[k]; return o; }, {}));
    res.json({ ok: true, totalItems: items.length, fields: Object.keys(items[0] || {}), sample });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});
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
    const { items, payer, shipping_cost = 0, seller_code, endereco } = req.body;
    if (!items || !items.length) return res.status(400).json({ ok: false, erro: "Carrinho vazio" });

    // Validar estoque
    const semEstoque = items.filter(item => {
      if (item.id === "desconto") return false; // cupom, não é produto
      const prod = cache.produtos.find(p => String(p.id) === String(item.id));
      return prod && !prod.inStock;
    });
    if (semEstoque.length > 0) {
      const nomes = semEstoque.map(i => i.name).join(", ");
      return res.status(400).json({ ok: false, erro: `Produto(s) fora de estoque: ${nomes}` });
    }

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
        endereco: endereco ? JSON.stringify(endereco) : null,
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

// ─── EMAIL DE NOTIFICAÇÃO ─────────────────────────────────────────────────────
const NOTIFY_EMAIL = "siteevendasonlineart@gmail.com";

async function enviarEmailPedido(pedido, payment) {
  try {
    // Buscar dados completos do pedido no Supabase
    let pedidoDB = pedido;
    if (!pedidoDB?.items) {
      const rows = await sb.select("pedidos", `id=eq.${pedido.id || payment.external_reference}`);
      if (rows?.length) pedidoDB = rows[0];
    }
    if (typeof pedidoDB.items === "string") pedidoDB.items = JSON.parse(pedidoDB.items);

    const itensHtml = (pedidoDB.items || []).map(i =>
      `<tr><td style="padding:8px;border-bottom:1px solid #eee">${i.name}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${i.qty}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">R$ ${Number(i.price).toFixed(2)}</td></tr>`
    ).join("");

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <div style="background:linear-gradient(135deg,#b91c1c,#ef4444);padding:20px;border-radius:12px 12px 0 0">
          <h1 style="color:white;margin:0;font-size:20px">🛒 Novo Pedido — Art Móveis</h1>
        </div>
        <div style="background:#fff;padding:20px;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px">
          <h2 style="color:#333;font-size:16px;margin-top:0">Pedido ${pedidoDB.id}</h2>
          <p style="color:#666;font-size:14px"><strong>Status:</strong> ${payment?.status || pedidoDB.status || "pending"}</p>
          <p style="color:#666;font-size:14px"><strong>Pagamento:</strong> ${payment?.payment_method_id || pedidoDB.payment_method || "—"}</p>
          <p style="color:#666;font-size:14px"><strong>Data:</strong> ${new Date().toLocaleString("pt-BR", {timeZone:"America/Fortaleza"})}</p>
          
          <h3 style="color:#333;font-size:14px;margin-top:20px;border-bottom:2px solid #ef4444;padding-bottom:5px">👤 Cliente</h3>
          <p style="color:#666;font-size:14px"><strong>Nome:</strong> ${pedidoDB.cliente_nome || "—"}</p>
          <p style="color:#666;font-size:14px"><strong>Email:</strong> ${pedidoDB.cliente_email || "—"}</p>
          <p style="color:#666;font-size:14px"><strong>Telefone:</strong> ${pedidoDB.cliente_telefone || "—"}</p>
          ${(() => { try { const e = typeof pedidoDB.endereco === "string" ? JSON.parse(pedidoDB.endereco) : pedidoDB.endereco; return e ? `<p style="color:#666;font-size:14px"><strong>Endereço:</strong> ${e.rua || ""}, ${e.numero || ""} — ${e.bairro || ""}, ${e.cidade || ""} · CEP ${e.cep || ""}</p>` : ""; } catch { return ""; } })()}
          
          <h3 style="color:#333;font-size:14px;margin-top:20px;border-bottom:2px solid #ef4444;padding-bottom:5px">📦 Produtos</h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <tr style="background:#f9f9f9"><th style="padding:8px;text-align:left">Produto</th><th style="padding:8px;text-align:center">Qtd</th><th style="padding:8px;text-align:right">Preço</th></tr>
            ${itensHtml}
          </table>
          
          <div style="margin-top:15px;padding:15px;background:#f9f9f9;border-radius:8px;font-size:14px">
            <div style="display:flex;justify-content:space-between;margin-bottom:5px"><span>Subtotal:</span><span>R$ ${Number(pedidoDB.subtotal || 0).toFixed(2)}</span></div>
            <div style="display:flex;justify-content:space-between;margin-bottom:5px"><span>Frete:</span><span>R$ ${Number(pedidoDB.frete || 0).toFixed(2)}</span></div>
            ${Number(pedidoDB.desconto) > 0 ? `<div style="display:flex;justify-content:space-between;margin-bottom:5px;color:#16a34a"><span>Desconto:</span><span>-R$ ${Number(pedidoDB.desconto).toFixed(2)}</span></div>` : ""}
            <div style="display:flex;justify-content:space-between;font-weight:bold;font-size:16px;border-top:2px solid #ddd;padding-top:8px;margin-top:5px"><span>TOTAL:</span><span style="color:#b91c1c">R$ ${Number(pedidoDB.total || 0).toFixed(2)}</span></div>
          </div>
          
          ${pedidoDB.seller_code === "RETIRADA_LOJA" ? '<p style="background:#dcfce7;color:#166534;padding:10px;border-radius:8px;font-size:13px;margin-top:15px">🏪 <strong>RETIRADA NA LOJA</strong></p>' : ""}
          
          <p style="color:#999;font-size:11px;margin-top:20px;text-align:center">App Art Móveis — Notificação automática</p>
        </div>
      </div>
    `;

    // Enviar via Resend (se tiver key) ou logar
    const RESEND_KEY = process.env.RESEND_KEY;
    if (RESEND_KEY) {
      await axios.post("https://api.resend.com/emails", {
        from: "Art Móveis <onboarding@resend.dev>",
        to: [NOTIFY_EMAIL],
        subject: `🛒 Pedido ${pedidoDB.id} — R$ ${Number(pedidoDB.total || 0).toFixed(2)} — ${pedidoDB.cliente_nome || "Cliente"}`,
        html,
      }, { headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" } });
      console.log(`[Email] Notificação enviada → ${NOTIFY_EMAIL}`);
    } else {
      console.log(`[Email] Sem RESEND_KEY — email não enviado. Dados do pedido logados acima.`);
    }
  } catch (e) {
    console.error("[Email] Erro:", e.response?.data || e.message);
  }
}

// ─── TESTE DE EMAIL (remover depois) ─────────────────────────────────────────
app.get("/test-email", async (req, res) => {
  const RESEND_KEY = process.env.RESEND_KEY;
  if (!RESEND_KEY) return res.json({ ok: false, erro: "RESEND_KEY não configurada" });
  try {
    const r = await axios.post("https://api.resend.com/emails", {
      from: "Art Móveis <onboarding@resend.dev>",
      to: [NOTIFY_EMAIL],
      subject: "✅ Teste — Email do App Art Móveis funcionando!",
      html: `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
        <div style="background:linear-gradient(135deg,#b91c1c,#ef4444);padding:20px;border-radius:12px 12px 0 0">
          <h1 style="color:white;margin:0;font-size:18px">✅ Teste de Email — Art Móveis</h1>
        </div>
        <div style="background:#fff;padding:20px;border:1px solid #eee;border-radius:0 0 12px 12px">
          <p style="color:#333;font-size:14px">Se você está lendo isso, o sistema de notificação por email está funcionando!</p>
          <p style="color:#666;font-size:13px">Quando um cliente finalizar uma compra pelo app, você receberá um email completo com todos os dados do pedido.</p>
          <p style="color:#999;font-size:11px;margin-top:20px;text-align:center">App Art Móveis — ${new Date().toLocaleString("pt-BR", {timeZone:"America/Fortaleza"})}</p>
        </div>
      </div>`,
    }, { headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" } });
    console.log("[Test Email] Enviado:", r.data);
    res.json({ ok: true, msg: `Email de teste enviado para ${NOTIFY_EMAIL}`, id: r.data?.id });
  } catch (e) {
    console.error("[Test Email] Erro:", e.response?.data || e.message);
    res.json({ ok: false, erro: e.response?.data || e.message });
  }
});

// ─── VALIDAÇÃO WEBHOOK MP ────────────────────────────────────────────────────

function validarWebhookMP(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true; // Se não configurou secret, aceita (mas loga aviso)
  
  const xSignature = req.headers["x-signature"];
  const xRequestId = req.headers["x-request-id"];
  
  if (!xSignature || !xRequestId) {
    console.warn("[Webhook] Sem x-signature ou x-request-id — rejeitado");
    return false;
  }
  
  // Extrair ts e v1 do header: "ts=123456,v1=abcdef..."
  const parts = {};
  xSignature.split(",").forEach(part => {
    const [key, val] = part.trim().split("=");
    if (key && val) parts[key] = val;
  });
  
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) {
    console.warn("[Webhook] x-signature mal formado — rejeitado");
    return false;
  }
  
  // Montar template: id:DATA_ID;request-id:REQUEST_ID;ts:TIMESTAMP;
  const dataId = req.body?.data?.id;
  const template = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
  
  const hash = crypto
    .createHmac("sha256", secret)
    .update(template)
    .digest("hex");
  
  if (hash !== v1) {
    console.warn(`[Webhook] Assinatura inválida — rejeitado`);
    return false;
  }
  
  return true;
}

// ─── WEBHOOK MP ───────────────────────────────────────────────────────────────
app.post("/webhook/mp", async (req, res) => {
  try {
    // Validar assinatura
    if (!validarWebhookMP(req)) {
      console.warn("[Webhook] Request não autenticado — ignorando");
      return res.status(401).send("Unauthorized");
    }
    
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

      // Enviar email de notificação
      await enviarEmailPedido({ id: orderId }, payment);
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
  const allowed = [
    process.env.APP_URL,
    "https://artmoveis-app.vercel.app",
    "https://app.lojasartmoveis.com.br"
  ].filter(Boolean);
  const referer = req.get("referer") || "";
  const appUrl = allowed.find(u => referer.startsWith(u)) || allowed[0] || "https://artmoveis-app.vercel.app";
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

// ─── AVALIAÇÕES ───────────────────────────────────────────────────────────────
app.post("/avaliacoes", async (req, res) => {
  try {
    const { produto_id, produto_nome, cliente_email, cliente_nome, stars, texto } = req.body;
    if (!produto_id || !cliente_email || !stars || !texto) return res.status(400).json({ ok: false, erro: "Campos obrigatórios faltando" });
    const row = await sb.insert("avaliacoes", { produto_id: String(produto_id), produto_nome, cliente_email, cliente_nome, stars: Number(stars), texto });
    res.json({ ok: true, avaliacao: row?.[0] || null });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get("/avaliacoes/produto/:id", async (req, res) => {
  try {
    const rows = await sb.select("avaliacoes", `produto_id=eq.${req.params.id}&order=created_at.desc&limit=50`);
    res.json({ ok: true, avaliacoes: rows || [], total: (rows || []).length });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get("/avaliacoes/cliente/:email", async (req, res) => {
  try {
    const rows = await sb.select("avaliacoes", `cliente_email=eq.${encodeURIComponent(req.params.email)}&order=created_at.desc&limit=50`);
    res.json({ ok: true, avaliacoes: rows || [], total: (rows || []).length });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── VENDEDORES ──────────────────────────────────────────────────────────────
app.get("/vendedores", async (_, res) => {
  try {
    const rows = await sb.select("vendedores", "order=created_at.desc");
    res.json({ ok: true, vendedores: rows || [] });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get("/vendedores/codigo/:code", async (req, res) => {
  try {
    const rows = await sb.select("vendedores", `codigo=eq.${req.params.code}&ativo=eq.true`);
    if (!rows?.length) return res.json({ ok: false, erro: "Código não encontrado" });
    const v = rows[0];
    res.json({ ok: true, vendedor: { nome: v.nome, loja: v.loja, codigo: v.codigo, comissao: v.comissao } });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post("/vendedores", async (req, res) => {
  try {
    const { nome, cpf, loja, codigo, comissao } = req.body;
    if (!nome || !cpf || !loja || !codigo) return res.status(400).json({ ok: false, erro: "Campos obrigatórios: nome, cpf, loja, codigo" });
    const row = await sb.insert("vendedores", { nome, cpf, loja, codigo: codigo.toUpperCase(), comissao: Number(comissao) || 0 });
    res.json({ ok: true, vendedor: row?.[0] || null });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.put("/vendedores/:id", async (req, res) => {
  try {
    const { nome, cpf, loja, codigo, comissao, ativo } = req.body;
    const updates = {};
    if (nome !== undefined) updates.nome = nome;
    if (cpf !== undefined) updates.cpf = cpf;
    if (loja !== undefined) updates.loja = loja;
    if (codigo !== undefined) updates.codigo = codigo.toUpperCase();
    if (comissao !== undefined) updates.comissao = Number(comissao);
    if (ativo !== undefined) updates.ativo = ativo;
    await sb.update("vendedores", { id: req.params.id }, updates);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.delete("/vendedores/:id", async (req, res) => {
  try {
    await sb.delete("vendedores", { id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── NOTIFICAÇÕES ────────────────────────────────────────────────────────────
app.get("/notificacoes/:email", async (req, res) => {
  try {
    const rows = await sb.select("notificacoes", `cliente_email=eq.${encodeURIComponent(req.params.email)}&order=created_at.desc&limit=50`);
    res.json({ ok: true, notificacoes: rows || [] });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post("/notificacoes", async (req, res) => {
  try {
    const { cliente_email, tipo, titulo, mensagem, pedido_id } = req.body;
    if (!cliente_email || !titulo || !mensagem) return res.status(400).json({ ok: false, erro: "Campos obrigatórios faltando" });
    const row = await sb.insert("notificacoes", { cliente_email, tipo: tipo || "sistema", titulo, mensagem, pedido_id: pedido_id || null });
    res.json({ ok: true, notificacao: row?.[0] || null });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.put("/notificacoes/:id/lida", async (req, res) => {
  try {
    await sb.update("notificacoes", { id: req.params.id }, { lida: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── ADMIN — PEDIDOS AVANÇADO ────────────────────────────────────────────────
app.put("/pedidos/:id", async (req, res) => {
  try {
    const updates = {};
    const allowed = ["status", "cliente_nome", "cliente_email", "cliente_telefone", "endereco", "shipped_at", "delivered_at"];
    for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k]; }
    updates.updated_at = new Date().toISOString();
    await sb.update("pedidos", { id: req.params.id }, updates);

    // Se mudou status, criar notificação pro cliente
    if (req.body.status) {
      const rows = await sb.select("pedidos", `id=eq.${req.params.id}`);
      const pedido = rows?.[0];
      if (pedido?.cliente_email) {
        const statusLabels = { approved: "Pagamento aprovado", shipped: "Pedido enviado", delivered: "Pedido entregue", rejected: "Pagamento recusado", cancelled: "Pedido cancelado" };
        const label = statusLabels[req.body.status] || req.body.status;
        await sb.insert("notificacoes", {
          cliente_email: pedido.cliente_email,
          tipo: "pedido",
          titulo: label,
          mensagem: `Seu pedido ${req.params.id} foi atualizado para: ${label}`,
          pedido_id: req.params.id,
        });
      }
    }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post("/pedidos", async (req, res) => {
  try {
    const { cliente_nome, cliente_email, cliente_telefone, items, subtotal, frete, desconto, total, seller_code, endereco, status } = req.body;
    if (!cliente_nome || !items?.length) return res.status(400).json({ ok: false, erro: "Nome e itens obrigatórios" });
    const orderId = `ART-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const row = await sb.insert("pedidos", {
      id: orderId, cliente_nome, cliente_email: cliente_email || null, cliente_telefone: cliente_telefone || null,
      items: JSON.stringify(items), subtotal: Number(subtotal) || 0, frete: Number(frete) || 0,
      desconto: Number(desconto) || 0, total: Number(total) || 0,
      status: status || "approved", seller_code: seller_code || null,
      endereco: endereco ? JSON.stringify(endereco) : null,
    });
    // Notificar
    if (cliente_email) {
      await sb.insert("notificacoes", {
        cliente_email, tipo: "pedido", titulo: "Novo pedido criado",
        mensagem: `Pedido ${orderId} criado com sucesso. Total: R$ ${Number(total || 0).toFixed(2)}`,
        pedido_id: orderId,
      });
    }
    res.json({ ok: true, pedido_id: orderId });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.delete("/pedidos/:id", async (req, res) => {
  try {
    // Cancelar em vez de deletar
    await sb.update("pedidos", { id: req.params.id }, { status: "cancelled", updated_at: new Date().toISOString() });
    const rows = await sb.select("pedidos", `id=eq.${req.params.id}`);
    const pedido = rows?.[0];
    if (pedido?.cliente_email) {
      await sb.insert("notificacoes", {
        cliente_email: pedido.cliente_email, tipo: "pedido",
        titulo: "Pedido cancelado", mensagem: `Seu pedido ${req.params.id} foi cancelado.`,
        pedido_id: req.params.id,
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── ADMIN — REENVIAR EMAIL ──────────────────────────────────────────────────
app.post("/pedidos/:id/reenviar-email", async (req, res) => {
  try {
    const rows = await sb.select("pedidos", `id=eq.${req.params.id}`);
    if (!rows?.length) return res.status(404).json({ ok: false, erro: "Pedido não encontrado" });
    await enviarEmailPedido(rows[0], { status: rows[0].status, payment_method_id: rows[0].payment_method });
    res.json({ ok: true, msg: "Email reenviado" });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── ADMIN — CLIENTES ────────────────────────────────────────────────────────
app.get("/clientes", async (_, res) => {
  try {
    const rows = await sb.select("clientes", "order=created_at.desc&limit=500");
    res.json({ ok: true, clientes: rows || [] });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.put("/clientes/:id", async (req, res) => {
  try {
    const updates = {};
    const allowed = ["nome", "email", "telefone", "endereco"];
    for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k]; }
    await sb.update("clientes", { id: req.params.id }, updates);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── FOTO DE PERFIL ──────────────────────────────────────────────────────────
app.post("/clientes/foto", async (req, res) => {
  try {
    const { email, foto_base64 } = req.body;
    if (!email || !foto_base64) return res.status(400).json({ ok: false, erro: "Email e foto obrigatórios" });

    // Extrair tipo e dados do base64
    const match = foto_base64.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ ok: false, erro: "Formato de imagem inválido" });
    
    const mimeType = match[1];
    const base64Data = match[2];
    const ext = mimeType.split("/")[1] || "jpg";
    const fileName = `${email.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}.${ext}`;
    const buffer = Buffer.from(base64Data, "base64");

    // Upload pro Supabase Storage
    const uploadRes = await axios.post(
      `${SUPABASE_URL}/storage/v1/object/avatars/${fileName}`,
      buffer,
      {
        headers: {
          "Content-Type": mimeType,
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "x-upsert": "true",
        },
      }
    );

    // URL pública
    const foto_url = `${SUPABASE_URL}/storage/v1/object/public/avatars/${fileName}`;

    // Atualizar na tabela clientes
    try {
      const existing = await sb.select("clientes", `email=eq.${encodeURIComponent(email)}`);
      if (existing?.length) {
        await sb.update("clientes", { email }, { foto_url });
      }
    } catch (e) { console.warn("[Foto] Erro ao salvar na tabela:", e.message); }

    res.json({ ok: true, foto_url });
  } catch (e) {
    console.error("[Foto] Erro upload:", e.response?.data || e.message);
    res.status(500).json({ ok: false, erro: e.response?.data?.message || e.message });
  }
});

app.get("/clientes/foto/:email", async (req, res) => {
  try {
    const rows = await sb.select("clientes", `email=eq.${encodeURIComponent(req.params.email)}&select=foto_url`);
    const foto_url = rows?.[0]?.foto_url || null;
    res.json({ ok: true, foto_url });
  } catch (e) { res.json({ ok: true, foto_url: null }); }
});

// ─── CUPONS DINÂMICOS ────────────────────────────────────────────────────────
app.get("/cupons", async (_, res) => {
  try {
    const rows = await sb.select("cupons", "order=created_at.desc");
    res.json({ ok: true, cupons: rows || [] });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get("/cupons/validar/:codigo", async (req, res) => {
  try {
    const rows = await sb.select("cupons", `codigo=eq.${req.params.codigo.toUpperCase()}&ativo=eq.true`);
    if (!rows?.length) return res.json({ ok: false, erro: "Cupom inválido" });
    const c = rows[0];
    // Verificar validade
    if (c.validade && new Date(c.validade) < new Date()) return res.json({ ok: false, erro: "Cupom expirado" });
    // Verificar uso máximo
    if (c.max_usos > 0 && c.usos_atual >= c.max_usos) return res.json({ ok: false, erro: "Cupom esgotado" });
    res.json({ ok: true, cupom: { codigo: c.codigo, tipo: c.tipo, valor: Number(c.valor), descricao: c.descricao, primeira_compra: c.primeira_compra } });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post("/cupons", async (req, res) => {
  try {
    const { codigo, tipo, valor, descricao, min_compra, max_usos, primeira_compra, validade } = req.body;
    if (!codigo || !tipo) return res.status(400).json({ ok: false, erro: "Código e tipo obrigatórios" });
    const row = await sb.insert("cupons", {
      codigo: codigo.toUpperCase(), tipo, valor: Number(valor) || 0, descricao: descricao || "",
      min_compra: Number(min_compra) || 0, max_usos: Number(max_usos) || 0,
      primeira_compra: !!primeira_compra, validade: validade || null,
    });
    res.json({ ok: true, cupom: row?.[0] || null });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.put("/cupons/:id", async (req, res) => {
  try {
    const updates = {};
    const allowed = ["codigo", "tipo", "valor", "descricao", "min_compra", "max_usos", "primeira_compra", "validade", "ativo"];
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        if (k === "codigo") updates[k] = req.body[k].toUpperCase();
        else if (["valor", "min_compra", "max_usos"].includes(k)) updates[k] = Number(req.body[k]);
        else updates[k] = req.body[k];
      }
    }
    await sb.update("cupons", { id: req.params.id }, updates);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.delete("/cupons/:id", async (req, res) => {
  try {
    await sb.delete("cupons", { id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// Incrementar uso do cupom (chamado após checkout aprovado)
app.post("/cupons/usar/:codigo", async (req, res) => {
  try {
    const rows = await sb.select("cupons", `codigo=eq.${req.params.codigo.toUpperCase()}`);
    if (rows?.length) {
      await sb.update("cupons", { id: rows[0].id }, { usos_atual: (rows[0].usos_atual || 0) + 1 });
    }
    res.json({ ok: true });
  } catch (e) { res.json({ ok: true }); }
});

// ─── BANNERS DINÂMICOS ──────────────────────────────────────────────────────
app.get("/banners", async (_, res) => {
  try {
    const rows = await sb.select("banners", "ativo=eq.true&order=ordem.asc");
    res.json({ ok: true, banners: rows || [] });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get("/banners/todos", async (_, res) => {
  try {
    const rows = await sb.select("banners", "order=ordem.asc");
    res.json({ ok: true, banners: rows || [] });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post("/banners", async (req, res) => {
  try {
    const { titulo, subtitulo, imagem_base64, acao, ordem } = req.body;
    if (!titulo) return res.status(400).json({ ok: false, erro: "Título obrigatório" });

    let imagem_url = null;
    if (imagem_base64) {
      const match = imagem_base64.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) {
        const mimeType = match[1];
        const ext = mimeType.split("/")[1] || "jpg";
        const fileName = `banner_${Date.now()}.${ext}`;
        const buffer = Buffer.from(match[2], "base64");
        await axios.post(`${SUPABASE_URL}/storage/v1/object/banners/${fileName}`, buffer, {
          headers: { "Content-Type": mimeType, "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "x-upsert": "true" },
        });
        imagem_url = `${SUPABASE_URL}/storage/v1/object/public/banners/${fileName}`;
      }
    }

    const row = await sb.insert("banners", { titulo, subtitulo: subtitulo || "", imagem_url, acao: acao || null, ordem: Number(ordem) || 0 });
    res.json({ ok: true, banner: row?.[0] || null });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.put("/banners/:id", async (req, res) => {
  try {
    const updates = {};
    const allowed = ["titulo", "subtitulo", "acao", "ordem", "ativo"];
    for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k]; }

    // Upload nova imagem se enviada
    if (req.body.imagem_base64) {
      const match = req.body.imagem_base64.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) {
        const mimeType = match[1];
        const ext = mimeType.split("/")[1] || "jpg";
        const fileName = `banner_${Date.now()}.${ext}`;
        const buffer = Buffer.from(match[2], "base64");
        await axios.post(`${SUPABASE_URL}/storage/v1/object/banners/${fileName}`, buffer, {
          headers: { "Content-Type": mimeType, "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "x-upsert": "true" },
        });
        updates.imagem_url = `${SUPABASE_URL}/storage/v1/object/public/banners/${fileName}`;
      }
    }

    await sb.update("banners", { id: req.params.id }, updates);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.delete("/banners/:id", async (req, res) => {
  try {
    await sb.delete("banners", { id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── PAINEL ADMIN ─────────────────────────────────────────────────────────────
app.get("/painel", (_, res) => {
  try {
    const html = readFileSync(join(__dirname, "painel.html"), "utf-8");
    res.type("html").send(html);
  } catch {
    res.type("html").send("<h1>painel.html não encontrado</h1><p>Coloque o arquivo painel.html na mesma pasta do server.js</p>");
  }
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({
  status: "online", autenticado: true, fonte: "XML",
  cachedProducts: cache.produtos.length,
  mp: !!MP_ACCESS_TOKEN, supabase: !!SUPABASE_KEY, resend: !!process.env.RESEND_KEY, webhook_secret: !!process.env.MP_WEBHOOK_SECRET,
  updatedAt: cache.updatedAt,
}));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Art Móveis v2 — porta ${PORT}`);
  console.log(`Supabase: ${SUPABASE_KEY ? "OK" : "SEM CHAVE"} | MP: ${MP_ACCESS_TOKEN ? "OK" : "SEM TOKEN"} | Resend: ${process.env.RESEND_KEY ? "OK" : "SEM KEY"} | Webhook Secret: ${process.env.MP_WEBHOOK_SECRET ? "OK" : "SEM SECRET (webhook aberto)"}`);
});
