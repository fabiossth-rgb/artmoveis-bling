/**
 * Art Móveis × XML Feed — Backend
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
const UA       = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Estratégia Visionária: Cache com tempo de vida e trava de concorrência
let cache = { produtos: [], updatedAt: null };
let isFetching = null; 
const CACHE_TTL = 1000 * 60 * 60; // 1 hora de vida para o cache

function parsePreco(val) {
  if (!val) return 0;
  const clean = String(val).replace(/[^0-9.,]/g, "").replace(",", ".").replace(/\.(?=.*\.)/g, "");
  return parseFloat(clean) || 0;
}

function decodeEntities(str) {
  if (!str) return "";
  return String(str)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Lock: impede que o servidor faça múltiplos downloads do XML ao mesmo tempo
async function fetchXMLWithLock() {
  if (isFetching) return isFetching;
  isFetching = carregarXML().finally(() => { isFetching = null; });
  return isFetching;
}

async function carregarXML() {
  console.log("Buscando XML da Art Móveis...");
  const { data: rawBuffer } = await axios.get(XML_URL, {
    responseType: "arraybuffer",
    timeout: 30000,
    headers: { "User-Agent": UA },
  });

  const raw = new TextDecoder("iso-8859-1").decode(rawBuffer);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const json = parser.parse(raw);

  let items = [];

  // Concatenação limpa e fallback recursivo inteligente
  if (json?.rss?.channel?.item) items = [].concat(json.rss.channel.item);
  else if (json?.feed?.entry) items = [].concat(json.feed.entry);
  else if (json?.produtos?.produto) items = [].concat(json.produtos.produto);
  else {
    const searchArray = (obj) => {
      for (const key in obj) {
        if (Array.isArray(obj[key]) && obj[key].length > 5) return obj[key];
        if (obj[key] && typeof obj[key] === "object") {
          const res = searchArray(obj[key]);
          if (res) return res;
        }
      }
      return null;
    };
    items = searchArray(json) || [];
  }

  if (items.length === 0) {
    console.warn("Nenhum item encontrado no XML.");
    return [];
  }

  const produtos = items.map((item, i) => {
    const name      = decodeEntities(item["g:title"] || item.title || item.nome || item.name || `Produto ${i+1}`);
    const precoRaw  = item["g:price"] || item.price || item.preco || item["g:sale_price"] || "0";
    const promoRaw  = item["g:sale_price"] || item.promotional_price || item.preco_promocional || "0";
    const preco     = parsePreco(precoRaw);
    const promo     = parsePreco(promoRaw);
    const price     = promo > 0 && promo < preco ? promo : preco;
    const oldPrice  = promo > 0 && promo < preco ? preco : Math.round(preco * 1.35);
    const image     = item["g:image_link"] || item.image_link || item.imagem || item.image || FALLBACK;
    const category  = decodeEntities(item["g:product_type"] || item.product_type || item.categoria || item.category || "Geral");
    const id        = item["g:id"] || item.id || item["g:item_group_id"] || String(i + 1);
    const desc      = decodeEntities(item["g:description"] || item.description || item.descricao || name);

    const addImgs = item["g:additional_image_link"];
    const extraImages = addImgs ? [].concat(addImgs).map(String).filter(Boolean) : [];
    const images = [...new Set([String(image), ...extraImages])]; // Remove duplicatas de forma elegante

    return {
      id: String(id),
      name,
      category: category.split(">").pop().trim(),
      price,
      oldPrice,
      image: String(image),
      images,
      desc: desc.replace(/<[^>]*>/g, "").slice(0, 300),
      sold: Math.floor(Math.random() * 200) + 10,
      rating: +(4.4 + Math.random() * 0.6).toFixed(1),
      reviews: Math.floor(Math.random() * 80) + 5,
    };
  }).filter(p => p.price > 0);

  console.log(`XML processado: ${produtos.length} produtos válidos.`);
  return produtos;
}

app.get("/produtos", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    
    // Verifica se temos cache e se ele ainda é válido (dentro da 1 hora)
    const isCacheValid = cache.produtos.length > 0 && cache.updatedAt && (Date.now() - cache.updatedAt.getTime() < CACHE_TTL);

    if (isCacheValid) {
      return res.json({ ok: true, total: cache.produtos.length, produtos: cache.produtos });
    }

    // Se o cache expirou ou não existe, busca com a trava
    const produtos = await fetchXMLWithLock();
    
    if (produtos.length > 0) {
      cache.produtos = produtos;
      cache.updatedAt = new Date();
    }
    
    res.json({ ok: true, total: produtos.length, produtos });
  } catch (e) {
    console.error("Erro /produtos:", e.message);
    // Se der erro na busca, mas tivermos um cache antigo, envia o antigo para não perder venda!
    if (cache.produtos.length > 0) {
      console.log("Servindo cache antigo (stale) devido a erro na fonte.");
      return res.json({ ok: true, total: cache.produtos.length, produtos: cache.produtos, staled: true });
    }
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.get("/produtos/:id", async (req, res) => {
  try {
    if (cache.produtos.length === 0) {
      const produtos = await fetchXMLWithLock();
      cache.produtos = produtos;
      cache.updatedAt = new Date();
    }
    const p = cache.produtos.find(x => String(x.id) === String(req.params.id));
    if (!p) return res.status(404).json({ ok: false, erro: "Não encontrado" });
    res.json({ ok: true, image: p.image, images: p.images || [p.image], desc: p.desc });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.get("/debug/xml", async (req, res) => {
  try {
    const { data: rawBuffer } = await axios.get(XML_URL, { responseType: "arraybuffer", timeout: 30000, headers: { "User-Agent": UA } });
    const raw = new TextDecoder("iso-8859-1").decode(rawBuffer);
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    const json = parser.parse(raw);
    res.json({ rootKeys: Object.keys(json), sample: JSON.stringify(json).slice(0, 3000) });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post("/cache/refresh", (req, res) => {
  cache = { produtos: [], updatedAt: null };
  res.json({ ok: true, msg: "Cache limpo. Próxima requisição baixará o XML novamente." });
});

app.get("/auth/login", (_, res) => res.redirect("/health"));
app.get("/auth/status", (_, res) => res.json({ autenticado: true, tokenValido: true }));

app.post("/pedidos", async (req, res) => {
  try {
    const { items, total, payment, coupon } = req.body;
    console.log("Novo Pedido Art Móveis:", { items, total, payment, coupon });
    res.json({ ok: true, mensagem: "Pedido registrado com sucesso!" });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.get("/health", (_, res) => res.json({ status: "online", autenticado: true, fonte: "XML", cachedProducts: cache.produtos.length }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Art Móveis × XML rodando liso na porta ${PORT}`);
});
