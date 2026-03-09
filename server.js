/**
 * Art Móveis × Bling — Backend Mínimo
 * Roda localmente e conecta o app ao Bling automaticamente
 */

import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.options("*", cors());
app.use(express.json());

const CLIENT_ID     = "ff08094e504660c39b73e49a2741483bc7134593";
const CLIENT_SECRET = "3fc67babe8b58937aca774428c495843423edbe1dfbb2b03d6aa027911df";
const REDIRECT_URI  = "https://artmoveis-bling-1.onrender.com/auth/callback";
const BLING_API     = "https://www.bling.com.br/Api/v3";

let token = { access: null, refresh: null, expiresAt: null };

function tokenValido() {
  return token.access && Date.now() < token.expiresAt - 30000;
}

async function renovarToken() {
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const { data } = await axios.post(
    "https://www.bling.com.br/Api/v3/oauth/token",
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${creds}` } }
  );
  token = { access: data.access_token, refresh: data.refresh_token || token.refresh, expiresAt: Date.now() + data.expires_in * 1000 };
  console.log("Token renovado automaticamente");
  return token.access;
}

async function getToken() {
  if (tokenValido()) return token.access;
  if (token.refresh) return renovarToken();
  throw new Error("nao_autenticado");
}

async function blingGet(path, params = {}) {
  const t = await getToken();
  const { data } = await axios.get(`${BLING_API}${path}`, {
    headers: { Authorization: `Bearer ${t}` }, params
  });
  return data;
}

// ─── CACHE DE CATEGORIAS ──────────────────────────────────────────────────────
let categoriaCache = {};

async function getCategorias() {
  if (Object.keys(categoriaCache).length > 0) return categoriaCache;
  try {
    const data = await blingGet("/categorias/produtos", { limite: 100, pagina: 1 });
    const lista = data.data || [];
    const novoCache = {};
    for (const c of lista) {
      if (c.id) novoCache[c.id] = c.descricao || c.nome || "Geral";
    }
    if (Object.keys(novoCache).length > 0) categoriaCache = novoCache;
    console.log(`${lista.length} categorias carregadas:`, categoriaCache);
  } catch(e) { console.warn("Erro ao buscar categorias:", e.message); }
  return categoriaCache;
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.get("/auth/login", (req, res) => {
  const state = Math.random().toString(36).substring(2);
  const url = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Codigo nao recebido");
  try {
    const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    const { data } = await axios.post(
      "https://www.bling.com.br/Api/v3/oauth/token",
      new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${creds}` } }
    );
    token = { access: data.access_token, refresh: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000 };
    console.log("Autenticado com sucesso!");
    // pre-carrega categorias
    getCategorias();
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#fef2f2">
        <h1 style="color:#dc2626">Conectado ao Bling!</h1>
        <p>Pode fechar esta aba e voltar ao app.</p>
        <script>setTimeout(()=>window.close(),2000)</script>
      </body></html>
    `);
  } catch (e) {
    res.status(500).send("Erro ao autenticar: " + e.message);
  }
});

app.get("/auth/status", (req, res) => {
  res.json({ autenticado: tokenValido() || !!token.refresh, tokenValido: tokenValido() });
});

// ─── DEBUG ────────────────────────────────────────────────────────────────────
app.get("/debug/produto", async (req, res) => {
  try {
    const lista = await blingGet("/produtos", { limite: 1, pagina: 1, situacao: "A" });
    const id = lista.data?.[0]?.id;
    if (!id) return res.json({ erro: "sem produtos" });
    const detalhe = await blingGet(`/produtos/${id}`);
    res.json(detalhe.data || detalhe);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get("/debug/categorias", async (req, res) => {
  try {
    categoriaCache = {}; // força recarregar
    const data = await blingGet("/categorias/produtos", { limite: 100, pagina: 1 });
    const lista = data.data || [];
    const mapa = {};
    for (const c of lista) {
      if (c.id) mapa[c.id] = c.descricao || c.nome || "Geral";
    }
    categoriaCache = mapa;
    res.json({ total: lista.length, categorias: mapa, raw: lista });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get("/debug/cats1", async (req, res) => {
  try { const d = await blingGet("/categorias/produtos", { limite: 100 }); res.json(d); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get("/debug/cats2", async (req, res) => {
  try { const d = await blingGet("/produtos/categorias", { limite: 100 }); res.json(d); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get("/debug/cats3", async (req, res) => {
  try { const d = await blingGet("/categorias", { limite: 100 }); res.json(d); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});

// ─── CACHE ────────────────────────────────────────────────────────────────────
let produtoCache = { produtos: [], cats: {}, updatedAt: null, enriching: false };

async function enriquecerEmBackground(lista) {
  if (produtoCache.enriching) return;
  produtoCache.enriching = true;
  console.log(`Background: enriquecendo ${lista.length} produtos...`);
  let ok = 0, erros = 0;
  for (const p of lista) {
    try {
      const detalhe = await blingGet(`/produtos/${p.id}`).then(r => r.data || r);
      const fullImg = detalhe.imagens?.internas?.[0]?.link || detalhe.imagens?.externas?.[0]?.link;
      if (fullImg) {
        const idx = produtoCache.produtos.findIndex(x => x.id === p.id);
        if (idx !== -1) { produtoCache.produtos[idx].image = fullImg; ok++; }
      }
      await new Promise(r => setTimeout(r, 700));
    } catch(e) {
      erros++;
      await new Promise(r => setTimeout(r, 2500)); // espera mais se der 429
    }
  }
  produtoCache.enriching = false;
  console.log(`Background concluído: ${ok} imagens atualizadas, ${erros} erros`);
}

// ─── PRODUTOS ─────────────────────────────────────────────────────────────────
app.get("/produtos", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");

    // Cache hit — retorna na hora
    if (produtoCache.produtos.length > 0) {
      console.log(`Cache: ${produtoCache.produtos.length} produtos (enriquecendo=${produtoCache.enriching})`);
      return res.json({ ok: true, total: produtoCache.produtos.length, produtos: produtoCache.produtos, enriching: produtoCache.enriching });
    }

    // Busca categorias
    const catData = await blingGet("/categorias/produtos", { limite: 100 });
    const cats = {};
    for (const c of (catData.data || [])) {
      if (c.id) cats[String(c.id)] = c.descricao || c.nome || "Geral";
    }
    console.log("Cats:", Object.keys(cats).length);

    // Busca todos os produtos paginado — SEM detalhe individual
    const lista = [];
    let pagina = 1;
    while (true) {
      const data = await blingGet("/produtos", { limite: 100, pagina, situacao: "A" });
      const lote = data.data || [];
      lista.push(...lote);
      console.log(`Página ${pagina}: ${lote.length} produtos (total: ${lista.length})`);
      if (lote.length < 100) break;
      pagina++;
      await new Promise(r => setTimeout(r, 300));
    }

    const produtos = lista.map(p => {
      const preco  = parseFloat(p.preco || 0);
      const promo  = parseFloat(p.precoPromocional || 0);
      const atual  = promo > 0 && promo < preco ? promo : preco;
      const antigo = promo > 0 && promo < preco ? preco : Math.round(preco * 1.35);
      const catId  = p.categoria?.id;
      const catNome = catId && cats[String(catId)] ? cats[String(catId)] : (p.categoria?.descricao || p.categoria?.nome || "Geral");
      return {
        id: p.id, name: p.nome, category: catNome, price: atual, oldPrice: antigo,
        image: p.imagemURL || "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400&q=80",
        desc: p.descricaoCurta || p.observacoes || p.nome,
        sold: Math.floor(Math.random() * 200) + 10,
        rating: +(4.4 + Math.random() * 0.6).toFixed(1),
        reviews: Math.floor(Math.random() * 80) + 5,
      };
    }).filter(p => p.price > 0);

    // Salva cache e dispara enriquecimento em background
    produtoCache.produtos = produtos;
    produtoCache.updatedAt = new Date();
    enriquecerEmBackground(lista); // não bloqueia

    res.json({ ok: true, total: produtos.length, produtos });
  } catch (e) {
    if (e.message === "nao_autenticado")
      return res.status(401).json({ ok: false, erro: "Faca login em https://artmoveis-bling-1.onrender.com/auth/login" });
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ─── DETALHE SOB DEMANDA ──────────────────────────────────────────────────────
app.get("/produtos/:id", async (req, res) => {
  try {
    const detalhe = await blingGet(`/produtos/${req.params.id}`);
    const p = detalhe.data || detalhe;
    const image = p.imagens?.internas?.[0]?.link || p.imagens?.externas?.[0]?.link || p.imagemURL || "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400&q=80";
    res.json({ ok: true, image, desc: p.descricaoCurta || p.observacoes || p.nome });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// Força refresh do cache
app.post("/cache/refresh", (req, res) => {
  produtoCache = { produtos: [], cats: {}, updatedAt: null, enriching: false };
  res.json({ ok: true, msg: "Cache limpo" });
});

// ─── PEDIDOS ──────────────────────────────────────────────────────────────────
app.post("/pedidos", async (req, res) => {
  try {
    const { items, total, payment, cep, coupon } = req.body;
    const venda = {
      numero: `ART-${Date.now()}`,
      data: new Date().toISOString().split("T")[0],
      contato: { nome: "Cliente App Art Moveis", tipoPessoa: "F" },
      itens: items.map(i => ({ produto: { id: i.id }, quantidade: i.qty, valor: i.price })),
      parcelas: [{ valor: total, formaPagamento: { id: payment === "pix" ? 17 : payment === "credit" ? 3 : 1 } }],
      observacoes: coupon ? `Cupom: ${coupon}` : "",
      situacao: { id: 6 },
    };
    console.log("Venda registrada:", venda);
    res.json({ ok: true, mensagem: "Pedido registrado no Bling!" });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.get("/health", (_, res) => res.json({ status: "online", autenticado: tokenValido() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Art Moveis x Bling rodando na porta ${PORT}`);
  console.log(`Auth: https://artmoveis-bling-1.onrender.com/auth/login`);
});
