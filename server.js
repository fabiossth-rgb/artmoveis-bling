/**
 * Art Móveis × Tray — Backend
 * Usa a API pública da Tray (sem autenticação)
 */

import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.options("*", cors());
app.use(express.json());

const TRAY_API  = "https://www.lojasartmoveis.com.br/web_api";
const FALLBACK  = "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400&q=80";

async function trayGet(path, params = {}) {
  const { data } = await axios.get(`${TRAY_API}${path}`, { params });
  return data;
}

// ─── CACHE ────────────────────────────────────────────────────────────────────
let cache = { produtos: [], cats: {}, updatedAt: null };

async function carregarCategorias() {
  try {
    const data = await trayGet("/categories", { limit: 100 });
    const lista = data.Categories || [];
    const mapa = {};
    for (const c of lista) {
      const cat = c.Category || c;
      if (cat.id) mapa[String(cat.id)] = cat.name || "Geral";
    }
    console.log(`${Object.keys(mapa).length} categorias Tray carregadas`);
    return mapa;
  } catch(e) {
    console.warn("Erro categorias:", e.message);
    return {};
  }
}

function melhorImagem(p) {
  try {
    const imgs = p.ProductImage || [];
    for (const size of ["180", "90", "30"]) {
      for (const img of imgs) {
        const url = img?.https?.[size] || img?.[size];
        if (url) return url;
      }
    }
  } catch(e) {}
  return FALLBACK;
}

function mapearProduto(p, cats) {
  const prod = p.Product || p;
  const preco  = parseFloat(prod.price || 0);
  const promo  = parseFloat(prod.promotional_price || 0);
  const atual  = promo > 0 && promo < preco ? promo : preco;
  const antigo = promo > 0 && promo < preco ? preco : Math.round(preco * 1.35);
  const catId  = String(prod.category_id || "");
  const catNome = cats[catId] || "Geral";
  const image  = melhorImagem(prod);

  return {
    id: prod.id,
    name: prod.name,
    category: catNome,
    price: atual,
    oldPrice: antigo,
    image,
    desc: prod.description || prod.short_description || prod.name,
    sold: Math.floor(Math.random() * 200) + 10,
    rating: +(4.4 + Math.random() * 0.6).toFixed(1),
    reviews: Math.floor(Math.random() * 80) + 5,
  };
}

async function carregarTodosProdutos(cats) {
  const todos = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const data = await trayGet("/products", {
      limit,
      offset,
      available: 1,
      sort: "id",
      order: "asc",
    });

    const lista = data.Products || [];
    for (const p of lista) todos.push(mapearProduto(p, cats));
    console.log(`Tray offset ${offset}: ${lista.length} produtos (total: ${todos.length})`);

    if (lista.length < limit) break;
    offset += limit;
    await new Promise(r => setTimeout(r, 200));
  }

  return todos.filter(p => p.price > 0);
}

// ─── PRODUTOS ─────────────────────────────────────────────────────────────────
app.get("/produtos", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");

    if (cache.produtos.length > 0) {
      console.log(`Cache hit: ${cache.produtos.length} produtos`);
      return res.json({ ok: true, total: cache.produtos.length, produtos: cache.produtos });
    }

    const cats = await carregarCategorias();
    const produtos = await carregarTodosProdutos(cats);

    cache.produtos = produtos;
    cache.cats = cats;
    cache.updatedAt = new Date();

    console.log(`Tray: ${produtos.length} produtos carregados`);
    res.json({ ok: true, total: produtos.length, produtos });
  } catch (e) {
    console.error("Erro /produtos:", e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ─── DETALHE SOB DEMANDA ──────────────────────────────────────────────────────
app.get("/produtos/:id", async (req, res) => {
  try {
    const data = await trayGet(`/products/${req.params.id}`);
    const p = (data.Products?.[0]?.Product) || data.Product || data;
    const image = melhorImagem(p);
    res.json({ ok: true, image, desc: p.description || p.short_description || p.name });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// Força refresh do cache
app.post("/cache/refresh", (req, res) => {
  cache = { produtos: [], cats: {}, updatedAt: null };
  res.json({ ok: true, msg: "Cache limpo" });
});

// AUTH (compatibilidade com o front)
app.get("/auth/login", (_, res) => res.redirect("/health"));
app.get("/auth/status", (_, res) => res.json({ autenticado: true, tokenValido: true }));

// ─── PEDIDOS ──────────────────────────────────────────────────────────────────
app.post("/pedidos", async (req, res) => {
  try {
    const { items, total, payment, cep, coupon } = req.body;
    console.log("Pedido:", { items, total, payment, coupon });
    res.json({ ok: true, mensagem: "Pedido registrado!" });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.get("/health", (_, res) => res.json({ status: "online", autenticado: true, fonte: "Tray" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Art Moveis x Tray rodando na porta ${PORT}`);
});
