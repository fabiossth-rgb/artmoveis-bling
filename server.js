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
    const { items, payer, shipping_cost = 0, seller_code, endereco } = req.body;
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

// ─── PAINEL ADMIN ─────────────────────────────────────────────────────────────
app.get("/painel", (_, res) => {
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Art Móveis — Painel de Pedidos</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,system-ui,sans-serif;background:#f5f5f5;color:#333}
.header{background:linear-gradient(135deg,#b91c1c,#ef4444);padding:20px;color:#fff}.header h1{font-size:20px;font-weight:900}.header p{font-size:12px;opacity:.7;margin-top:4px}
.filters{padding:12px 16px;display:flex;gap:8px;overflow-x:auto;background:#fff;border-bottom:1px solid #eee}
.filters button{padding:6px 14px;border-radius:20px;border:1px solid #ddd;background:#fff;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}
.filters button.active{background:#b91c1c;color:#fff;border-color:#b91c1c}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;padding:16px}
.stat{background:#fff;border-radius:12px;padding:16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.stat .num{font-size:24px;font-weight:900;color:#b91c1c}.stat .label{font-size:11px;color:#999;margin-top:4px}
.orders{padding:0 16px 100px}
.order{background:#fff;border-radius:12px;padding:16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.order .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.order .id{font-weight:800;font-size:13px}.order .badge{font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px}
.badge-approved{background:#dcfce7;color:#166534}.badge-pending{background:#fef9c3;color:#854d0e}.badge-rejected{background:#fee2e2;color:#991b1b}
.order .info{font-size:12px;color:#666;margin:3px 0}.order .items{font-size:12px;color:#888;margin-top:6px}
.order .total{font-size:16px;font-weight:900;color:#b91c1c;margin-top:8px}
.empty{text-align:center;padding:60px 20px;color:#ccc;font-size:14px}
.loading{text-align:center;padding:60px;color:#999}
</style></head><body>
<div class="header"><h1>Painel Art Móveis</h1><p>Gestão de pedidos em tempo real</p></div>
<div class="filters" id="filters">
<button class="active" data-s="all">Todos</button><button data-s="approved">Pagos</button><button data-s="pending">Pendentes</button><button data-s="rejected">Recusados</button>
</div>
<div class="stats" id="stats"></div>
<div class="orders" id="orders"><div class="loading">Carregando pedidos...</div></div>
<script>
let allOrders=[];const $=id=>document.getElementById(id);
async function load(){
  try{const r=await fetch('/pedidos?limit=200');const d=await r.json();allOrders=d.pedidos||[];render('all');}
  catch(e){$('orders').innerHTML='<div class="empty">Erro ao carregar</div>';}
}
function render(filter){
  const list=filter==='all'?allOrders:allOrders.filter(o=>o.status===filter);
  const approved=allOrders.filter(o=>o.status==='approved');
  const totalVendas=approved.reduce((s,o)=>s+Number(o.total||0),0);
  $('stats').innerHTML=\`
    <div class="stat"><div class="num">\${allOrders.length}</div><div class="label">Total Pedidos</div></div>
    <div class="stat"><div class="num">\${approved.length}</div><div class="label">Pagos</div></div>
    <div class="stat"><div class="num">R$ \${totalVendas.toFixed(2)}</div><div class="label">Faturamento</div></div>
    <div class="stat"><div class="num">\${allOrders.filter(o=>o.status==='pending').length}</div><div class="label">Pendentes</div></div>
  \`;
  document.querySelectorAll('.filters button').forEach(b=>{b.classList.toggle('active',b.dataset.s===filter);b.onclick=()=>render(b.dataset.s);});
  if(!list.length){$('orders').innerHTML='<div class="empty">Nenhum pedido</div>';return;}
  $('orders').innerHTML=list.map(o=>{
    const items=(Array.isArray(o.items)?o.items:[]).map(i=>\`\${i.name} x\${i.qty}\`).join(', ');
    const badge=o.status==='approved'?'badge-approved':o.status==='pending'?'badge-pending':'badge-rejected';
    const label=o.status==='approved'?'Pago':o.status==='pending'?'Pendente':o.status==='rejected'?'Recusado':o.status;
    const date=o.created_at?new Date(o.created_at).toLocaleString('pt-BR'):'';
    return \`<div class="order">
      <div class="top"><span class="id">\${o.id}</span><span class="badge \${badge}">\${label}</span></div>
      <div class="info"><strong>\${o.cliente_nome||'—'}</strong> · \${o.cliente_email||''}</div>
      <div class="info">\${o.cliente_telefone||''} · \${date}</div>
      \${o.payment_method?'<div class="info">Pagamento: '+o.payment_method+'</div>':''}
      \${o.seller_code==='RETIRADA_LOJA'?'<div class="info" style="color:#166534">🏪 Retirada na loja</div>':''}
      \${(()=>{try{const e=typeof o.endereco==='string'?JSON.parse(o.endereco):o.endereco;return e?'<div class="info">📍 '+[e.rua,e.numero,e.bairro,e.cidade,'CEP '+e.cep].filter(Boolean).join(', ')+'</div>':'';}catch{return '';}})()}
      <div class="items">\${items}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
        <span style="font-size:11px;color:#999">Frete: R$ \${Number(o.frete||0).toFixed(2)}</span>
        <span class="total">R$ \${Number(o.total||0).toFixed(2)}</span>
      </div>
    </div>\`;
  }).join('');
}
load();setInterval(load,30000);
</script></body></html>`);
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({
  status: "online", autenticado: true, fonte: "XML",
  cachedProducts: cache.produtos.length,
  mp: !!MP_ACCESS_TOKEN, supabase: !!SUPABASE_KEY, resend: !!process.env.RESEND_KEY,
  updatedAt: cache.updatedAt,
}));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Art Móveis v2 — porta ${PORT}`);
  console.log(`Supabase: ${SUPABASE_KEY ? "OK" : "SEM CHAVE"} | MP: ${MP_ACCESS_TOKEN ? "OK" : "SEM TOKEN"}`);
});
