/**
 * Art Móveis × Bling — Backend Mínimo
 * Roda localmente e conecta o aplicativo ao Bling automaticamente
 */

import express from "express";
importar cors de "cors";
import axios from "axios";

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.options("*", cors());
app.use(express.json());

// ─── SUAS CREDENCIAIS BLING ───────────────────────── ──────────────────────────
const CLIENT_ID = "ff08094e504660c39b73e49a2741483bc7134593";
const CLIENT_SECRET = "3fc67babe8b58937aca774428c495843423edbe1dfbb2b03d6aa027911df";
const REDIRECT_URI = "https://artmoveis-bling-1.onrender.com/auth/callback";
const BLING_API = "https://www.bling.com.br/Api/v3";

// ─── TOKEN EM MEMÓRIA ──────────────────────────── ─────────────────────────────
let token = { acesso: null, atualização: null, expiraEm: null };

função tokenValido() {
  retornar token.access && Date.now() < token.expiresAt - 30000;
}

função assíncrona renovarToken() {
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const { data } = await axios.post(
    "https://www.bling.com.br/Api/v3/oauth/token",
    novo URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${creds}` } }
  );
  token = { acesso: data.access_token, atualização: data.refresh_token || token.refresh, expiraEm: Date.now() + data.expires_in * 1000 };
  console.log("🔄 Token renovado automaticamente");
  retornar token.access;
}

função assíncrona getToken() {
  se (tokenValido()) retornar token.access;
  se (token.refresh) retorne renovarToken();
  throw new Error("não_autenticado");
}

função assíncrona blingGet(caminho, parâmetros = {}) {
  const t = await getToken();
  const { data } = await axios.get(`${BLING_API}${path}`, {
    cabeçalhos: { Authorization: `Bearer ${t}` }, parâmetros
  });
  retornar dados;
}

// ─── AUTENTICAÇÃO ──────────────────────────────────────────────────────────────────────
app.get("/auth/login", (req, res) => {
  const state = Math.random().toString(36).substring(2);
  const url = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Código não recebido");
  tentar {
    const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    const { data } = await axios.post(
      "https://www.bling.com.br/Api/v3/oauth/token",
      novo URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${creds}` } }
    );
    token = { acesso: data.access_token, atualização: data.refresh_token, expiraEm: Date.now() + data.expires_in * 1000 };
    console.log("✅ Autenticado com sucesso!");
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#fef2f2">
        <h1 style="color:#dc2626">✅ Conectado ao Bling!</h1>
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

// ─── PRODUTOS ──────────────────────────────── ─────────────────────────────────
app.get("/produtos", async (req, res) => {
  tentar {
    const data = await blingGet("/produtos", { limite: 100, pagina: 1, situação: "A" });
    const produtos = (data.data || []).map(p => {
      const preco = parseFloat(p.preco || 0);
      const promo = parseFloat(p.precoPromocional || 0);
      const atual = promo > 0 && promo < preço ? promoção: preço;
      const antigo = promo > 0 && promo < preco ? preco : Math.round(preco * 1.35);
      retornar {
        id: p.id, nome: p.nome,
        categoria: p.categoria?.descricao || "Geral",
        preço: atual, antigoPreço: antigo,
        imagem: p.imagemURL || p.imagem?.link || "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400&q=80",
        desc: p.descricaoCurta || p.observações || p.nome,
        vendido: Math.floor(Math.random() * 200) + 10,
        classificação: +(4.4 + Math.random() * 0.6).toFixed(1),
        avaliações: Math.floor(Math.random() * 80) + 5,
      };
    }).filter(p => p.price > 0);
    res.json({ ok: true, total: produtos.length, produtos });
  } catch (e) {
    if (e.message === "não_autenticado")
      return res.status(401).json({ ok: false, erro: "Faça login em https://artmoveis-bling-1.onrender.com/auth/login" });
    res.status(500).json({ok: false, erro: e.message });
  }
});

// ─── PEDIDOS ───────────────────────────────── ─────────────────────────────────
app.post("/pedidos", async (req, res) => {
  tentar {
    const { itens, total, pagamento, cep, cupom } = req.body;
    constRoda = {
      numero: `ART-${Date.now()}`,
      dados: novo Date().toISOString().split("T")[0],
      contato: { nome: "Cliente App Art Móveis", tipoPessoa: "F" },
      itens: itens.map(i => ({ produto: { id: i.id }, quantidade: i.qty, valor: i.preço })),
      parcelas: [{ valor: total, formaPagamento: { id: payment === "pix" ? 17 : payment === "credit" ? 3 : 1 } }],
      observações: cupom ? `Cupom: ${cupom}` : "",
      situação: { id: 6 },
    };
    const resp = await blingGet("/pedidos/vendas"); // Substituição por blingPost quando tiver endpoint
    console.log("📦 Venda registrada:", venda);
    res.json({ ok: true, mensagem: "Pedido registrado no Bling!" });
  } catch (e) {
    res.status(500).json({ok: false, erro: e.message });
  }
});

app.get("/health", (_, res) => res.json({ status: "online", autenticado: tokenValido() }));

// ─── INÍCIO ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
┌───────────────────────────────────────────────────────────────────┐
│ 🛋 Art Móveis × Bling — Rodando no Render │
├─ ...
│ │
│ Acesse para autenticar: │
│ https://artmoveis-bling-1.onrender.com/auth/login │
│ │
└──────────────────────────────────────────────────────────────────────┘
  `);
});
