require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { GoogleGenAI } = require('@google/genai');
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const multer = require('multer');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCodeLib = require('qrcode');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_JWT = process.env.JWT_SECRET || "financia_autonoma_chave_secreta_2026";
const PDFParse = require('pdf2json');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Servir arquivos estáticos (Frontend / PWA)
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Inicialização segura da IA
const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    apiVersion: 'v1'
});
const upload = multer({ storage: multer.memoryStorage() });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect((err) => {
    if (err) {
        console.error("❌ Erro ao conectar ao PostgreSQL:", err.message);
    } else {
        console.log("🐘 Banco de dados PostgreSQL conectado com sucesso!");
    }
});

// Keep-Alive para evitar que o Render entre em modo de espera (sleep)
setInterval(() => {
    const urlPing = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    fetch(`${urlPing}/api/entradas`).catch(() => { });
}, 10 * 60 * 1000);

async function inicializarTabelas() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id SERIAL PRIMARY KEY,
                nome VARCHAR(255),
                email VARCHAR(255) UNIQUE,
                senha VARCHAR(255),
                grupo_id VARCHAR(255)
            );
            CREATE TABLE IF NOT EXISTS transacoes (
                id SERIAL PRIMARY KEY,
                usuario_id INTEGER,
                descricao VARCHAR(255),
                valor NUMERIC(10,2),
                categoria VARCHAR(100),
                data VARCHAR(50)
            );
            CREATE TABLE IF NOT EXISTS gastos_fixos (
                id SERIAL PRIMARY KEY,
                usuario_id INTEGER,
                descricao VARCHAR(255),
                valor NUMERIC(10,2),
                vencimento VARCHAR(50),
                pago INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS ativos_portfolio (
                id SERIAL PRIMARY KEY,
                usuario_id INTEGER,
                tipo VARCHAR(50),
                ticker VARCHAR(50),
                quantidade NUMERIC(15,8),
                preco_medio NUMERIC(10,2),
                data_compra VARCHAR(50)
            );
            CREATE TABLE IF NOT EXISTS entradas (
                id SERIAL PRIMARY KEY,
                usuario_id INTEGER,
                descricao VARCHAR(255),
                valor NUMERIC(10,2),
                data VARCHAR(50)
            );
            CREATE TABLE IF NOT EXISTS aportes (
                id SERIAL PRIMARY KEY,
                usuario_id INTEGER,
                mes VARCHAR(255),
                valor NUMERIC(10,2),
                data VARCHAR(50)
            );
        `);
        // Garante que a coluna grupo_id exista mesmo em bancos já criados anteriormente
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS grupo_id VARCHAR(255);`);
        await pool.query(`ALTER TABLE ativos_portfolio ADD COLUMN IF NOT EXISTS data_compra VARCHAR(50);`);
        await pool.query(`ALTER TABLE ativos_portfolio ALTER COLUMN quantidade TYPE NUMERIC(15,8);`);
        console.log("✅ Tabelas PostgreSQL verificadas/criadas com sucesso!");
    } catch (e) {
        console.error("Erro ao inicializar tabelas:", e.message);
    }
}
inicializarTabelas();

async function chamarComRetry(prompt, imagemBase64 = null) {
    try {
        // Inicializa o modelo com segurança dentro da função usando a SDK
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        let parts = [{ text: prompt }];

        if (imagemBase64) {
            parts.push({
                inlineData: {
                    mimeType: "image/jpeg",
                    data: imagemBase64
                }
            });
        }

        const response = await model.generateContent({
            contents: [{ parts: parts }]
        });

        // Extrai o texto da resposta do formato oficial da SDK da Google
        const respostaTexto = response.response.text();

        if (respostaTexto) {
            return { text: respostaTexto };
        }
    } catch (err) {
        console.error("❌ Erro definitivo na chamada do Gemini:", err.message);
        throw err;
    }
}

function autenticarToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ erro: "Acesso negado. Faça login para continuar." });

    jwt.verify(token, SECRET_JWT, (err, usuario) => {
        if (err) return res.status(403).json({ erro: "Sessão expirada. Faça login novamente." });
        req.usuario = usuario;
        next();
    });
}

// Rota de Suporte Admin para inspecionar cadastros e IDs de grupos
app.get('/admin/usuarios-suporte', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT id, nome, email, senha, grupo_id FROM usuarios ORDER BY id ASC');
        res.json({
            sucesso: true,
            totalUsuarios: resultado.rows.length,
            usuarios: resultado.rows
        });
    } catch (err) {
        res.status(500).json({ erro: err.message });
    }
});

// Rota de Reset Total do Banco de Dados
app.get('/api/reset-banco-dados-total', async (req, res) => {
    try {
        await pool.query('DROP TABLE IF EXISTS transacoes, entradas, aportes, gastos_fixos, ativos_portfolio, usuarios CASCADE;');
        await inicializarTabelas();
        res.json({ mensagem: "✅ Banco de dados PostgreSQL resetado e recriado com sucesso!" });
    } catch (err) {
        res.status(500).json({ erro: "Erro ao resetar banco:", detalhes: err.message });
    }
});

// Helper otimizado e seguro para obter cotação em tempo real de FIIs, Ações e Cripto
async function obterCotacaoAtual(ticker, tipo) {
    const t = ticker.toUpperCase().trim();

    if (tipo === 'Cripto' || t === 'BTC' || t === 'BITCOIN') {
        try {
            const res = await fetch('https://economia.awesomeapi.com.br/json/last/BTC-BRL');
            const data = await res.json();
            if (data?.BTCBRL?.bid) return parseFloat(data.BTCBRL.bid);
        } catch (e) { }

        try {
            const res = await fetch('https://api.mercadobitcoin.net/api/v4/tickers?symbols=BTC-BRL');
            const data = await res.json();
            if (data?.[0]?.last) return parseFloat(data[0].last);
        } catch (e) { }

        return 380000.00;
    }

    try {
        const res = await fetch(`https://brapi.dev/api/quote/${t}`);
        const data = await res.json();
        if (data?.results?.[0]?.regularMarketPrice) {
            return parseFloat(data.results[0].regularMarketPrice);
        }
    } catch (e) { }

    return 10.00;
}

// Rotas de Autenticação
app.post('/api/cadastrar', async (req, res) => {
    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ erro: "Preencha todos os campos." });

    try {
        const hashSenha = bcrypt.hashSync(senha, 8);
        await pool.query(`INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3)`, [nome, email, hashSenha]);
        res.status(201).json({ mensagem: "Conta criada com sucesso!" });
    } catch (err) {
        res.status(400).json({ erro: "E-mail já cadastrado no sistema." });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, senha } = req.body;
    try {
        const result = await pool.query(`SELECT * FROM usuarios WHERE email = $1`, [email]);
        const usuario = result.rows[0];
        if (!usuario || !bcrypt.compareSync(senha, usuario.senha)) {
            return res.status(400).json({ erro: "Usuário ou senha incorretos." });
        }
        const token = jwt.sign({ id: usuario.id, nome: usuario.nome }, SECRET_JWT, { expiresIn: '24h' });
        res.json({ token, nome: usuario.nome });
    } catch (err) {
        res.status(500).json({ erro: "Erro ao realizar login." });
    }
});

app.post('/api/esqueci-senha', async (req, res) => {
    const { email, novaSenha } = req.body;
    if (!email || !novaSenha) return res.status(400).json({ erro: "Informe o e-mail e a nova senha." });

    try {
        const result = await pool.query(`SELECT * FROM usuarios WHERE email = $1`, [email]);
        if (result.rows.length === 0) return res.status(404).json({ erro: "E-mail não encontrado." });
        const hashSenha = bcrypt.hashSync(novaSenha, 8);
        await pool.query(`UPDATE usuarios SET senha = $1 WHERE email = $2`, [hashSenha, email]);
        res.json({ mensagem: "Senha alterada com sucesso!" });
    } catch (err) {
        res.status(500).json({ erro: "Erro ao redefinir senha." });
    }
});

// Rotas de Entradas
app.get('/api/entradas', autenticarToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM entradas WHERE usuario_id = $1 ORDER BY id DESC`, [req.usuario.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ erro: "Erro ao buscar entradas." }); }
});

app.post('/api/entradas', autenticarToken, async (req, res) => {
    const { descricao, valor } = req.body;
    const valNum = parseFloat(valor);
    if (!descricao || isNaN(valNum) || valNum <= 0) return res.status(400).json({ erro: "Dados inválidos." });
    const dataHoje = new Date().toLocaleDateString('pt-BR');
    try {
        const result = await pool.query(`INSERT INTO entradas (usuario_id, descricao, valor, data) VALUES ($1, $2, $3, $4) RETURNING id`, [req.usuario.id, descricao, valNum, dataHoje]);
        res.status(201).json({ id: result.rows[0].id, descricao, valor: valNum, data: dataHoje });
    } catch (err) { res.status(500).json({ erro: "Erro ao salvar entrada." }); }
});

app.delete('/api/entradas/:id', autenticarToken, async (req, res) => {
    try {
        await pool.query(`DELETE FROM entradas WHERE id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id]);
        res.json({ mensagem: "Entrada removida." });
    } catch (err) { res.status(500).json({ erro: "Erro ao excluir entrada." }); }
});

// Rotas de Aportes
app.get('/api/aportes', autenticarToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM aportes WHERE usuario_id = $1 ORDER BY id ASC`, [req.usuario.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ erro: "Erro ao buscar aportes." }); }
});

app.post('/api/aportes', autenticarToken, async (req, res) => {
    const { mes, valor } = req.body;
    const valNum = parseFloat(valor);
    if (!mes || isNaN(valNum) || valNum <= 0) return res.status(400).json({ erro: "Dados inválidos." });

    const agora = new Date();
    const agoraBrasilia = new Date(agora.getTime() - (3 * 60 * 60 * 1000));
    const dia = String(agoraBrasilia.getUTCDate()).padStart(2, '0');
    const mesStr = String(agoraBrasilia.getUTCMonth() + 1).padStart(2, '0');
    const ano = agoraBrasilia.getUTCFullYear();
    const horas = String(agoraBrasilia.getUTCHours()).padStart(2, '0');
    const minutos = String(agoraBrasilia.getUTCMinutes()).padStart(2, '0');

    const dataSimples = `${dia}/${mesStr}/${ano}`;
    const dataHoraCompleta = `${dataSimples} às ${horas}:${minutos}`;

    try {
        const result = await pool.query(`INSERT INTO aportes (usuario_id, mes, valor, data) VALUES ($1, $2, $3, $4) RETURNING id`, [req.usuario.id, mes, valNum, dataHoraCompleta]);
        res.status(201).json({ id: result.rows[0].id, mes, valor: valNum, data: dataHoraCompleta });
    } catch (err) { res.status(500).json({ erro: "Erro ao salvar aporte." }); }
});

app.delete('/api/aportes/:id', autenticarToken, async (req, res) => {
    try {
        await pool.query(`DELETE FROM aportes WHERE id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id]);
        res.json({ mensagem: "Aporte removido." });
    } catch (err) { res.status(500).json({ erro: "Erro ao excluir aporte." }); }
});

// Rotas de Transações
app.get('/api/extrato', autenticarToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM transacoes WHERE usuario_id = $1 ORDER BY id DESC`, [req.usuario.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ erro: "Erro ao buscar extrato." }); }
});

app.post('/api/transacao', autenticarToken, async (req, res) => {
    const { descricao, valor } = req.body;
    const valorNum = parseFloat(valor);
    if (!descricao || isNaN(valorNum) || valorNum <= 0) return res.status(400).json({ erro: "Dados inválidos." });

    const descNorm = descricao.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    let categoria = "Compras";

    if (
        descNorm.includes('uber') || descNorm.includes('99') || descNorm.includes('posto') ||
        descNorm.includes('gasolina') || descNorm.includes('combustivel') || descNorm.includes('moto') ||
        descNorm.includes('mecanica') || descNorm.includes('oficina') || descNorm.includes('manutencao') ||
        descNorm.includes('capacete') || descNorm.includes('pneu') || descNorm.includes('troca de oleo') ||
        descNorm.includes('oleo') || descNorm.includes('pedagio') || descNorm.includes('estacionamento')
    ) {
        categoria = 'Transporte';
    } else if (
        descNorm.includes('ifood') || descNorm.includes('restaurante') || descNorm.includes('lanche') ||
        descNorm.includes('acai') || descNorm.includes('pizza') || descNorm.includes('cinema') ||
        descNorm.includes('streaming') || descNorm.includes('jantar') || descNorm.includes('bar')
    ) {
        categoria = 'Lazer';
    } else if (
        descNorm.includes('mercado') || descNorm.includes('supermercado') || descNorm.includes('agua pra beber') ||
        descNorm.includes('padaria') || descNorm.includes('paes') || descNorm.includes('feira') ||
        descNorm.includes('horti') || descNorm.includes('acougue') || descNorm.includes('atacadao')
    ) {
        categoria = 'Mercado';
    } else if (
        descNorm.includes('luz') || descNorm.includes('agua') || descNorm.includes('internet') ||
        descNorm.includes('enel') || descNorm.includes('cagece') || descNorm.includes('aluguel') ||
        descNorm.includes('condominio') || descNorm.includes('acessorios')
    ) {
        categoria = 'Casa';
    }

    const dataHoje = new Date().toLocaleDateString('pt-BR');
    try {
        const result = await pool.query(
            `INSERT INTO transacoes (usuario_id, descricao, valor, categoria, data) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [req.usuario.id, descricao, valorNum, categoria, dataHoje]
        );
        res.status(201).json({ id: result.rows[0].id, descricao, valor: valorNum, categoria, data: dataHoje });
    } catch (err) { res.status(500).json({ erro: "Erro ao salvar transação." }); }
});

app.delete('/api/transacao/:id', autenticarToken, async (req, res) => {
    try {
        await pool.query(`DELETE FROM transacoes WHERE id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id]);
        res.json({ mensagem: "Transação removida." });
    } catch (err) { res.status(500).json({ erro: "Erro ao excluir transação." }); }
});

app.post('/api/importar-ofx', autenticarToken, upload.single('arquivoOfx'), async (req, res) => {
    console.log("📥 [EXTRATO] Processando arquivo enviado...");
    try {
        if (!req.file) {
            return res.status(400).json({ erro: "Nenhum arquivo enviado." });
        }

        let conteudoArquivo = req.file.buffer.toString('utf8')
            .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F]/g, "")
            .slice(0, 15000);

        const usuarioId = req.usuario.id;
        const dataHoje = new Date().toLocaleDateString('pt-BR');

        let transacoesExtraidas = [];

        try {
            const prompt = `
            Você é um assistente financeiro especialista. Analise o extrato bancário em texto abaixo e extraia TODAS as transações reais de entrada e saída.

            REGRAS DE CATEGORIZAÇÃO:
            - "Mercado": Supermercados, padarias, açougues, hortifruti, atacadões.
            - "Transporte": Uber, 99, postos de gasolina, pedágio, pneu, moto, mecânica.
            - "Casa": Luz, água, internet, gás, aluguel, condomínio.
            - "Lazer": iFood, restaurantes, lanchonetes, açaí, jantar, streaming.
            - "Compras": Compras gerais, farmácia, vestuário, PIX enviados.
            - "Entrada": Salários, PIX recebidos, rendimentos, vendas.

            FORMATO DE SAÍDA EXIGIDO:
            Retorne APENAS um array JSON puro (sem markdown, sem \`\`\`json):
            [
              {"descricao": "Supermercado Extra", "valor": 150.00, "tipo": "saida", "categoria": "Mercado"},
              {"descricao": "Uber", "valor": 25.00, "tipo": "saida", "categoria": "Transporte"},
              {"descricao": "Pix Recebido", "valor": 1200.00, "tipo": "entrada", "categoria": "Entrada"}
            ]

            Texto do Extrato:
            """
            ${conteudoArquivo}
            """
            `;

            const respostaIA = await chamarComRetry(prompt);
            let textoResposta = respostaIA.text || '';
            let jsonLimpo = textoResposta.replace(/```json/gi, '').replace(/```/g, '').trim();
            const inicio = jsonLimpo.indexOf('[');
            const fim = jsonLimpo.lastIndexOf(']');
            if (inicio !== -1 && fim !== -1) {
                jsonLimpo = jsonLimpo.substring(inicio, fim + 1);
            }

            transacoesExtraidas = JSON.parse(jsonLimpo);
        } catch (errIA) {
            console.warn("⚠️ [EXTRATO] IA indisponível. Iniciando varredura RegEx...");
            const linhas = conteudoArquivo.split(/\r?\n/);
            const mapUnicas = new Map();

            for (let linha of linhas) {
                const matchVal = linha.match(/(-?\d+[\.,]\d{2})/);
                if (matchVal) {
                    const valNum = Math.abs(parseFloat(matchVal[1].replace('.', '').replace(',', '.')));
                    let descLimpa = linha.replace(matchVal[0], '')
                        .replace(/R\$/g, '')
                        .replace(/\d{2}\/\d{2}\/\d{4}/g, '')
                        .replace(/\b\d{6,}\b/g, '')
                        .trim();

                    if (valNum > 0 && valNum < 50000 && descLimpa.length >= 2 && !descLimpa.toLowerCase().includes('saldo')) {
                        let cat = 'Compras';
                        const dL = descLimpa.toLowerCase();

                        if (dL.includes('mercado') || dL.includes('super') || dL.includes('padaria')) cat = 'Mercado';
                        else if (dL.includes('uber') || dL.includes('99') || dL.includes('posto') || dL.includes('pneu') || dL.includes('moto')) cat = 'Transporte';
                        else if (dL.includes('ifood') || dL.includes('jantar') || dL.includes('lanche')) cat = 'Lazer';
                        else if (dL.includes('luz') || dL.includes('agua') || dL.includes('internet')) cat = 'Casa';

                        const chave = `${descLimpa}_${valNum}`;
                        if (!mapUnicas.has(chave)) {
                            mapUnicas.set(chave, { descricao: descLimpa.slice(0, 50), valor: valNum, tipo: 'saida', categoria: cat });
                        }
                    }
                }
            }
            transacoesExtraidas = Array.from(mapUnicas.values());
        }

        if (!Array.isArray(transacoesExtraidas) || transacoesExtraidas.length === 0) {
            return res.status(400).json({ erro: "Nenhuma transação válida identificada." });
        }

        let qtdSaidas = 0;
        let qtdEntradas = 0;

        for (let t of transacoesExtraidas) {
            const desc = t.descricao ? t.descricao.trim() : 'Movimentação';
            const val = Math.abs(parseFloat(t.valor) || 0);
            const tipo = (t.tipo || 'saida').toLowerCase();
            const cat = ['Mercado', 'Casa', 'Lazer', 'Transporte', 'Compras'].includes(t.categoria) ? t.categoria : 'Compras';

            if (val > 0) {
                if (tipo === 'entrada' || cat === 'Entrada') {
                    await pool.query(`INSERT INTO entradas (usuario_id, descricao, valor, data) VALUES ($1, $2, $3, $4)`, [usuarioId, desc, val, dataHoje]);
                    qtdEntradas++;
                } else {
                    await pool.query(`INSERT INTO transacoes (usuario_id, descricao, valor, categoria, data) VALUES ($1, $2, $3, $4, $5)`, [usuarioId, desc, val, cat, dataHoje]);
                    qtdSaidas++;
                }
            }
        }

        res.json({ mensagem: `✅ Extrato importado com sucesso: ${qtdSaidas} saídas e ${qtdEntradas} entradas!` });
    } catch (err) {
        res.status(500).json({ erro: "Erro interno no servidor: " + err.message });
    }
});

app.delete('/api/limpar-extrato', autenticarToken, async (req, res) => {
    try {
        await pool.query('DELETE FROM transacoes WHERE usuario_id = $1', [req.usuario.id]);
        res.json({ mensagem: "✅ Extrato limpo com sucesso!" });
    } catch (err) { res.status(500).json({ erro: "Erro ao limpar extrato." }); }
});

// Rotas de Gastos Fixos
app.get('/api/gastos-fixos', autenticarToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM gastos_fixos WHERE usuario_id = $1 AND (pago = 0 OR pago IS NULL)`, [req.usuario.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ erro: "Erro ao buscar gastos fixos." }); }
});

app.post('/api/gastos-fixos', autenticarToken, async (req, res) => {
    const { descricao, valor, vencimento } = req.body;
    try {
        const result = await pool.query(`INSERT INTO gastos_fixos (usuario_id, descricao, valor, vencimento, pago) VALUES ($1, $2, $3, $4, 0) RETURNING id`, [req.usuario.id, descricao, valor, vencimento]);
        res.status(201).json({ id: result.rows[0].id, descricao, valor, vencimento });
    } catch (err) { res.status(500).json({ erro: "Erro ao cadastrar conta fixa." }); }
});

app.put('/api/gastos-fixos/:id/pago', autenticarToken, async (req, res) => {
    try {
        const busca = await pool.query(`SELECT * FROM gastos_fixos WHERE id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id]);
        const conta = busca.rows[0];
        if (!conta) return res.status(404).json({ erro: "Conta não encontrada." });

        await pool.query(`UPDATE gastos_fixos SET pago = 1 WHERE id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id]);
        const dataHoje = new Date().toLocaleDateString('pt-BR');
        await pool.query(`INSERT INTO transacoes (usuario_id, descricao, valor, categoria, data) VALUES ($1, $2, $3, $4, $5)`, [req.usuario.id, `[PAGO] ${conta.descricao}`, conta.valor, 'Casa', dataHoje]);
        res.json({ mensagem: "Pagamento registrado!" });
    } catch (err) { res.status(500).json({ erro: "Erro ao dar baixa." }); }
});

app.delete('/api/gastos-fixos/:id', autenticarToken, async (req, res) => {
    try {
        await pool.query(`DELETE FROM gastos_fixos WHERE id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id]);
        res.json({ mensagem: "Gasto fixo removido." });
    } catch (err) { res.status(500).json({ erro: "Erro ao excluir." }); }
});

// Rotas de Ativos
app.get('/api/ativos', autenticarToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM ativos_portfolio WHERE usuario_id = $1 ORDER BY id DESC`, [req.usuario.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ erro: "Erro ao buscar ativos." }); }
});

app.post('/api/ativos', autenticarToken, async (req, res) => {
    const { tipo, ticker, quantidade, preco_medio, data_compra } = req.body;
    const qtdNum = parseFloat(quantidade);
    const precoNum = parseFloat(preco_medio);

    if (!ticker || isNaN(qtdNum) || qtdNum <= 0 || isNaN(precoNum) || precoNum < 0) {
        return res.status(400).json({ erro: "Dados do ativo inválidos." });
    }

    const tickerLimpo = ticker.toUpperCase().trim();
    let tipoFinal = tipo || 'FIIs';
    const dataFinal = data_compra || new Date().toLocaleDateString('pt-BR');

    try {
        const result = await pool.query(
            `INSERT INTO ativos_portfolio (usuario_id, tipo, ticker, quantidade, preco_medio, data_compra) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [req.usuario.id, tipoFinal, tickerLimpo, qtdNum, precoNum, dataFinal]
        );
        res.status(201).json({ id: result.rows[0].id, mensagem: "Ativo cadastrado com sucesso!" });
    } catch (err) {
        res.status(500).json({ erro: "Erro ao cadastrar ativo no banco de dados." });
    }
});

app.delete('/api/ativos/:id', autenticarToken, async (req, res) => {
    try {
        await pool.query(`DELETE FROM ativos_portfolio WHERE id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id]);
        res.json({ mensagem: "Ativo removido." });
    } catch (err) { res.status(500).json({ erro: "Erro ao excluir ativo." }); }
});

// ==========================================
// DECLARAÇÃO GLOBAL DA SESSÃO DO WHATSAPP
// ==========================================
const sessoesWhatsApp = {};

async function iniciarBotUsuario(usuarioId) {
    if (sessoesWhatsApp[usuarioId]?.sock && sessoesWhatsApp[usuarioId]?.status === 'conectado') {
        return;
    }

    // 🎯 CORREÇÃO CRUCIAL: Pasta de autenticação 100% isolada e exclusiva por usuário
    const pastaAuth = path.join(__dirname, `auth_info_user_${usuarioId}`);
    const { state, saveCreds } = await useMultiFileAuthState(pastaAuth);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        markOnlineOnConnect: true,
        keepAliveIntervalMs: 30000,
        browser: ['FinancIA Autônoma', 'Chrome', '1.0.0'],
    });

    sessoesWhatsApp[usuarioId] = { sock, status: 'iniciando', qr: '', grupoId: null };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessoesWhatsApp[usuarioId].status = 'aguardando_qr';
            sessoesWhatsApp[usuarioId].qr = await QRCodeLib.toDataURL(qr);
            console.log(`🔄 QR Code gerado para o Usuário ID ${usuarioId}`);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            sessoesWhatsApp[usuarioId].status = 'desconectado';
            sessoesWhatsApp[usuarioId].qr = '';

            if (statusCode !== DisconnectReason.loggedOut) {
                console.log(`🔄 Reconectando WhatsApp do Usuário ID ${usuarioId}...`);
                setTimeout(() => iniciarBotUsuario(usuarioId), 5000);
            }
        } else if (connection === 'open') {
            sessoesWhatsApp[usuarioId].status = 'conectado';
            sessoesWhatsApp[usuarioId].qr = '';
            console.log(`🚀 WhatsApp conectado permanentemente para o Usuário ID ${usuarioId}!`);

            await new Promise(resolve => setTimeout(resolve, 2000));

            try {
                const todosGrupos = await sock.groupFetchAllParticipating();
                let gruposArray = Object.values(todosGrupos);
                let grupoExistente = gruposArray.find(g => g.subject === "FinancIA - Gestão Financeira");

                let targetGroupId = null;

                if (grupoExistente) {
                    targetGroupId = grupoExistente.id;
                    console.log(`📌 [WHATSAPP] Grupo oficial já existe com ID: ${targetGroupId}`);
                } else {
                    const meuNumeroJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                    const resGrupo = await sock.groupCreate("FinancIA - Gestão Financeira", [meuNumeroJid]);
                    targetGroupId = resGrupo.id;
                    console.log(`👥 [WHATSAPP] Novo grupo criado com ID: ${targetGroupId}`);

                    await new Promise(resolve => setTimeout(resolve, 3000));

                    const caminhoFoto = path.join(__dirname, 'icon.png');
                    if (fs.existsSync(caminhoFoto)) {
                        try {
                            const bufferFoto = fs.readFileSync(caminhoFoto);
                            await sock.updateProfilePicture(targetGroupId, bufferFoto);
                            console.log(`🖼️ [WHATSAPP] Foto 'icon.png' definida para o grupo!`);
                        } catch (errFoto) {
                            console.error(`⚠️ Erro ao definir foto do grupo:`, errFoto.message);
                        }
                    }

                    const mensagemBoasVindas =
                        `👋 *Bem-vindo ao FinancIA Autônoma!*

Este é o seu grupo exclusivo para registro de gastos, entradas e investimentos. Todas as mensagens enviadas aqui serão organizadas automaticamente no seu painel!

📌 *Como registrar seus dados (Comandos e Gatilhos):*

💸 *Gastos e Compras:*
• Envie: \`gasto 25 mercado\`
• Envie: \`paguei 40 gasolina\`
• Envie: \`comprei 150 farmácia\`

💰 *Entradas e Salários:*
• Envie: \`entrada 1200 salário\`
• Envie: \`recebi 150 pix do cliente\`

🎯 *Reserva de Emergência:*
• Envie: \`reserva 200\` ou \`aporte 500\`

📈 *Investimentos (Carteira):*
• *FIIs:* \`fii 10 cotas MXRF11\`
• *Ações:* \`compra 5 acoes PETR4\`
• *Cripto:* \`cripto 100 bitcoin\`

🚀 *Dica:* Você também pode enviar comprovantes em foto ou áudios que nossa IA irá interpretar para você!`;

                    try {
                        await sock.sendMessage(targetGroupId, { text: mensagemBoasVindas });
                        console.log(`📩 Mensagem de boas-vindas enviada com sucesso!`);
                    } catch (errMsg) {
                        console.error(`⚠️ Erro ao enviar mensagem de boas-vindas:`, errMsg.message);
                    }
                }

                sessoesWhatsApp[usuarioId].grupoId = targetGroupId;

                // Salva o grupo ID no banco de dados vinculado a este usuário
                await pool.query(
                    `UPDATE usuarios SET grupo_id = $1 WHERE id = $2`,
                    [targetGroupId, usuarioId]
                );

                console.log(`✅ [WHATSAPP] ID do Grupo Oficial vinculado ao Usuário ID ${usuarioId}: ${targetGroupId}`);

            } catch (errGrupo) {
                console.error(`ℹ️ [WHATSAPP] Erro no gerenciamento de grupo:`, errGrupo.message);
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg || !msg.message) return;

            const remetenteRaw = msg.key.remoteJid;

            // Processa apenas mensagens de grupo (@g.us)
            if (!remetenteRaw.endsWith('@g.us')) return;

            // 🎯 ISOLAMENTO POR BANCO DE DADOS: Descobre rigorosamente qual usuário é dono deste grupo exato
            const resDono = await pool.query(
                `SELECT id FROM usuarios WHERE grupo_id = $1`,
                [remetenteRaw]
            );

            if (resDono.rows.length === 0) {
                return; // Se o grupo não pertence a nenhum usuário cadastrado, ignora
            }

            const idUsuarioReal = resDono.rows.id;

            console.log(`📩 Mensagem recebida do grupo oficial [${remetenteRaw}] pertencente ao Usuário ID: ${idUsuarioReal}`);

            const textoChecagem = (
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.documentMessage?.caption ||
                ''
            ).trim();

            const textoMin = textoChecagem.toLowerCase();

            // TRAVA ANTI-LOOP INTELIGENTE:
            // Ignora apenas as mensagens automáticas geradas pelo próprio bot para evitar loop infinito,
            // permitindo que você digite os comandos livremente no seu número.
            if (msg.key.fromMe && (
                textoMin.includes('entrada registrada no financia') ||
                textoMin.includes('gasto registrado no financia') ||
                textoMin.includes('comprovante registrado') ||
                textoMin.includes('comprovante de entrada registrado') ||
                textoMin.includes('aporte na reserva registrado') ||
                textoMin.includes('de fii registrada') ||
                textoMin.includes('de ação registrada') ||
                textoMin.includes('de cripto registrada') ||
                textoMin.includes('bem-vindo ao financia')
            )) {
                return;
            }

            console.log(`📩 Mensagem recebida e aceita do grupo oficial [${remetenteRaw}] pertencente ao Usuário ID: ${idUsuarioReal}:`, JSON.stringify(msg.message));

            const ehImagem = !!msg.message.imageMessage;
            const ehDocumento = !!msg.message.documentMessage;
            const mimeTypeDoc = msg.message.documentMessage?.mimetype || '';
            const ehPDF = ehDocumento && mimeTypeDoc.includes('pdf');

            let textoMensagem = textoChecagem;
            let imagemBase64 = null;
            let textoExtraidoPDF = '';

            if (ehPDF) {
                try {
                    const bufferPDF = await downloadMediaMessage(msg, 'buffer', {});
                    textoExtraidoPDF = await new Promise((resolve) => {
                        const pdfParser = new PDFParser(null, 1);
                        pdfParser.on("pdfParser_dataError", () => resolve(""));
                        pdfParser.on("pdfParser_dataReady", () => {
                            resolve(pdfParser.getRawTextContent());
                        });
                        pdfParser.parseBuffer(bufferPDF);
                    });
                    console.log("📄 [COMPROVANTE PDF] Texto extraído com sucesso!");
                } catch (errPdf) {
                    console.error("Erro ao ler comprovante PDF:", errPdf.message);
                }
            }

            if (ehImagem) {
                try {
                    const bufferImagem = await downloadMediaMessage(msg, 'buffer', {});
                    imagemBase64 = bufferImagem.toString('base64');
                    console.log("🖼️ [COMPROVANTE IMAGEM] Baixado para análise da IA!");
                } catch (errImg) {
                    console.error("Erro ao baixar imagem de comprovante:", errImg.message);
                }
            }

            if (ehImagem || ehPDF) {
                const promptComprovante = `
Você é o motor de inteligência financeira do FinancIA. 
Sua tarefa é analisar este comprovante (Pix, transferência ou cartão) e extrair os dados com MÁXIMA PRECISÃO.

[DADOS DE ENTRADA]
${textoExtraidoPDF ? `Texto do PDF:\n"${textoExtraidoPDF}"` : ''}
Legenda/Texto enviado pelo usuário: "${textoMensagem}"

[HIERARQUIA DE REGRAS DE CATEGORIZAÇÃO E DESCRIÇÃO]

1. REGRA SUPREMA - COM LEGENDA DO USUÁRIO:
   - Se o usuário digitou algum texto na legenda (ex: "jantar", "mercado", "gasolina"):
     * A CATEGORIA DEVE ser definida estritamente com base na legenda (ex: "jantar" -> "Lazer" ou "Alimentação"; "mercado" -> "Mercado").
     * A DESCRIÇÃO pode combinar o nome do recebedor/estabelecimento com a intenção do usuário (ex: "Pix enviado para Fulano de Tal (jantar)" ou apenas "Jantar").

2. REGRA SECUNDÁRIA - SEM LEGENDA DO USUÁRIO (ANÁLISE DE CNPJ / ESTABELECIMENTO):
   - Se o usuário NÃO enviou nenhuma legenda (ou apenas enviou o arquivo):
     * Analise o nome da empresa, razão social ou nome do recebedor presente no comprovante.
     * DEDUSA a categoria automaticamente:
       - Nomes contendo "Supermercado", "Mercado", "Atacadista", "Moranguinho" -> Categoria: "Mercado".
       - Nomes contendo "Açaí", "Restaurante", "Pizzaria", "Hamburgueria", "Bar" -> Categoria: "Lazer" ou "Alimentação".
       - Nomes contendo "Posto", "Combustíveis", "Auto Posto" -> Categoria: "Transporte".
       - Nomes contendo "Farmácia", "Drogaria" -> Categoria: "Saúde".
       - Pix para Pessoa Física sem legenda -> Categoria: "Outros" ou "Transferências".
     * A DESCRIÇÃO DEVE ser o nome exato do recebedor/estabelecimento (ex: "Supermercado Moranguinho").

3. EXTRAÇÃO DE VALOR E TIPO:
   - VALOR: Extraia o valor numérico exato em formato decimal (ex: 650.00 ou 60.00).
   - TIPO: "saida" para pagamentos/Pix enviados ou "entrada" para Pix/transferências recebidas.

[FORMATO DA RESPOSTA]
Responda EXATAMENTE E APENAS um objeto JSON válido (sem formatação markdown, sem \`\`\`json):
{
  "eGasto": true,
  "descricao": "Nome do Estabelecimento ou Descrição baseada no Usuário",
  "valor": 0.00,
  "tipo": "saida",
  "categoria": "Nome da Categoria"
}`;

                try {
                    let respostaIA = ehImagem && imagemBase64 ?
                        await chamarComRetry(promptComprovante, imagemBase64) :
                        await chamarComRetry(promptComprovante);

                    if (respostaIA && respostaIA.text) {
                        let jsonLimpo = respostaIA.text.trim().replace(/```json/gi, '').replace(/```/g, '').trim();
                        const inicio = jsonLimpo.indexOf('{');
                        const fim = jsonLimpo.lastIndexOf('}');
                        if (inicio !== -1 && fim !== -1) jsonLimpo = jsonLimpo.substring(inicio, fim + 1);
                        const resComp = JSON.parse(jsonLimpo);

                        if (resComp.eGasto) {
                            const dataSimples = new Date().toLocaleDateString('pt-BR');
                            const valorNum = parseFloat(resComp.valor);

                            if (resComp.tipo === 'entrada') {
                                await pool.query(
                                    `INSERT INTO entradas (usuario_id, descricao, valor, data) VALUES ($1, $2, $3, $4)`,
                                    [idUsuarioReal, resComp.descricao, valorNum, dataSimples]
                                );

                                await sock.sendMessage(remetenteRaw, {
                                    text: `✅ *Comprovante de Entrada Registrado!*\n💰 *Valor:* R$ ${valorNum.toFixed(2)}\n📝 *Descrição:* ${resComp.descricao}`
                                });
                            } else {
                                const descNorm = resComp.descricao.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                                let cat = 'Compras';

                                if (
                                    descNorm.includes('uber') || descNorm.includes('99') || descNorm.includes('posto') ||
                                    descNorm.includes('gasolina') || descNorm.includes('combustivel') || descNorm.includes('moto') ||
                                    descNorm.includes('mecanica') || descNorm.includes('oficina') || descNorm.includes('manutencao')
                                ) {
                                    cat = 'Transporte';
                                } else if (
                                    descNorm.includes('ifood') || descNorm.includes('restaurante') || descNorm.includes('lanche') ||
                                    descNorm.includes('acai') || descNorm.includes('pizza') || descNorm.includes('jantar') || descNorm.includes('bar')
                                ) {
                                    cat = 'Lazer';
                                } else if (
                                    descNorm.includes('mercado') || descNorm.includes('supermercado') || descNorm.includes('padaria') || descNorm.includes('feira')
                                ) {
                                    cat = 'Mercado';
                                } else if (
                                    descNorm.includes('luz') || descNorm.includes('agua') || descNorm.includes('internet') || descNorm.includes('aluguel')
                                ) {
                                    cat = 'Casa';
                                }

                                await pool.query(
                                    `INSERT INTO transacoes (usuario_id, descricao, valor, categoria, data) VALUES ($1, $2, $3, $4, $5)`,
                                    [idUsuarioReal, resComp.descricao, valorNum, cat, dataSimples]
                                );

                                await sock.sendMessage(remetenteRaw, {
                                    text: `📌 *Comprovante Registrado!*\n💸 *Valor:* R$ ${valorNum.toFixed(2)}\n🏷️ *Categoria:* ${cat}\n📝 *Descrição:* ${resComp.descricao}`
                                });
                            }
                            return;
                        }
                    }
                } catch (errCompIA) {
                    console.error("Erro na análise do comprovante via IA:", errCompIA.message);
                }
            }

            if (!textoMensagem) return;

            const textoMinusculo = textoMensagem.toLowerCase();
            const dataSimples = new Date().toLocaleDateString('pt-BR');
            const dataHoraCompleta = `${dataSimples} às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;

            // 1. RESERVA DE EMERGÊNCIA
            if (textoMinusculo.includes('reserva') || textoMinusculo.includes('aporte')) {
                const matchVal = textoMensagem.match(/\d+([.,]\d+)?/);
                if (matchVal) {
                    const valor = parseFloat(matchVal[0].replace(',', '.'));
                    await pool.query(`INSERT INTO aportes (usuario_id, mes, valor, data) VALUES ($1, $2, $3, $4)`,
                        [idUsuarioReal, `Reserva de Emergência (${dataSimples})`, valor, dataHoraCompleta]);

                    await sock.sendMessage(remetenteRaw, {
                        text: `🎯 *Aporte na Reserva Registrado!*\n💰 *Valor:* R$ ${valor.toFixed(2)}\n📅 *Data/Hora:* ${dataHoraCompleta}`
                    });
                    return;
                }
            }

            // 2. FIIs
            if (textoMinusculo.includes('fii') || textoMinusculo.includes('fundo')) {
                const isVenda = textoMinusculo.includes('vendi');
                const matchCotas = textoMensagem.match(/(\d+)\s*cotas?/i);
                const matchVal = textoMensagem.match(/\d+([.,]\d+)?\s*reais/i) || textoMensagem.match(/r\$\s*\d+([.,]\d+)?/i);
                const matchTicker = textoMensagem.match(/\b([a-zA-Z]{4}\d{1,2})\b/);

                const ticker = matchTicker ? matchTicker[1].toUpperCase() : 'MXRF11';
                const cotacao = await obterCotacaoAtual(ticker, 'FIIs');

                let cotas = matchCotas ? parseFloat(matchCotas[1]) : 1;
                let valorTotal = cotas * cotacao;

                if (matchVal) {
                    valorTotal = parseFloat(matchVal[0].replace(/[^0-9.,]/g, '').replace(',', '.'));
                    cotas = valorTotal / cotacao;
                }

                const multiplier = isVenda ? -1 : 1;

                await pool.query(`INSERT INTO ativos_portfolio (usuario_id, tipo, ticker, quantidade, preco_medio, data_compra) VALUES ($1, $2, $3, $4, $5, $6)`,
                    [idUsuarioReal, 'FIIs', ticker, cotas * multiplier, cotacao, dataHoraCompleta]);

                await sock.sendMessage(remetenteRaw, {
                    text: `🏢 *${isVenda ? 'Venda' : 'Compra'} de FII Registrada!*\n🏷️ *Ticker:* ${ticker}\n📊 *Cotas:* ${cotas.toFixed(2)}\n💵 *Cotação:* R$ ${cotacao.toFixed(2)}\n💰 *Total:* R$ ${valorTotal.toFixed(2)}\n📅 *Data/Hora:* ${dataHoraCompleta}`
                });
                return;
            }

            // 3. AÇÕES
            if (textoMinusculo.includes('acao') || textoMinusculo.includes('ações') || textoMinusculo.includes('acoes')) {
                const isVenda = textoMinusculo.includes('vendi');
                const matchCotas = textoMensagem.match(/(\d+)\s*cotas?/i);
                const matchTicker = textoMensagem.match(/\b([a-zA-Z]{4}\d{1,2})\b/);

                const ticker = matchTicker ? matchTicker[1].toUpperCase() : 'PETR4';
                const cotacao = await obterCotacaoAtual(ticker, 'Ações');
                let cotas = matchCotas ? parseFloat(matchCotas[1]) : 1;
                let valorTotal = cotas * cotacao;

                const multiplier = isVenda ? -1 : 1;

                await pool.query(`INSERT INTO ativos_portfolio (usuario_id, tipo, ticker, quantidade, preco_medio, data_compra) VALUES ($1, $2, $3, $4, $5, $6)`,
                    [idUsuarioReal, 'Ações', ticker, cotas * multiplier, cotacao, dataHoraCompleta]);

                await sock.sendMessage(remetenteRaw, {
                    text: `📈 *${isVenda ? 'Venda' : 'Compra'} de Ação Registrada!*\n🏷️ *Ticker:* ${ticker}\n📊 *Qtd:* ${cotas}\n💵 *Cotação:* R$ ${cotacao.toFixed(2)}\n💰 *Total:* R$ ${valorTotal.toFixed(2)}\n📅 *Data/Hora:* ${dataHoraCompleta}`
                });
                return;
            }

            // 4. CRIPTO
            if (textoMinusculo.includes('cripto') || textoMinusculo.includes('btc') || textoMinusculo.includes('bitcoin')) {
                const isVenda = textoMinusculo.includes('vendi');
                const matchVal = textoMensagem.match(/\d+([.,]\d+)?/);
                if (matchVal) {
                    const valorReais = parseFloat(matchVal[0].replace(',', '.'));
                    const cotacaoBtc = await obterCotacaoAtual('BTC', 'Cripto');
                    const fracaoBtc = valorReais / cotacaoBtc;

                    const multiplier = isVenda ? -1 : 1;

                    await pool.query(`INSERT INTO ativos_portfolio (usuario_id, tipo, ticker, quantidade, preco_medio, data_compra) VALUES ($1, $2, $3, $4, $5, $6)`,
                        [idUsuarioReal, 'Cripto', 'BTC', fracaoBtc * multiplier, cotacaoBtc, dataHoraCompleta]);

                    await sock.sendMessage(remetenteRaw, {
                        text: `🪙 *${isVenda ? 'Venda' : 'Compra'} de Cripto Registrada!*\n🏷️ *Ativo:* Bitcoin (BTC)\n📊 *Fracionado:* ${fracaoBtc.toFixed(8)} BTC\n💵 *Cotação BTC:* R$ ${cotacaoBtc.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}\n💰 *Total:* R$ ${valorReais.toFixed(2)}\n📅 *Data/Hora:* ${dataHoraCompleta}`
                    });
                    return;
                }
            }

            // 5. PROCESSAMENTO DE GASTOS E ENTRADAS POR TEXTO
            const gatilhos = ['!', '/', 'gasto', 'paguei', 'comprei', 'entrada', 'recebi', 'ganhei', 'vendi'];
            const temGatilho = gatilhos.some(g => textoMinusculo.startsWith(g) || textoMinusculo.includes(g));
            if (!temGatilho) return;

            const eGatilhoEntrada = ['entrada', 'recebi', 'ganhei', 'vendi'].some(g => textoMinusculo.includes(g));
            let textoLimpo = textoMensagem;
            gatilhos.forEach(g => {
                textoLimpo = textoLimpo.replace(new RegExp(g, 'gi'), '').trim();
            });

            const promptIA = `
            Analise a mensagem financeira abaixo e extraia a descrição, valor e tipo.
            Mensagem: "${textoLimpo}"
            Responda EXATAMENTE e APENAS um JSON no formato abaixo (sem marcadores markdown):
            {"eGasto": true, "descricao": "Gasto", "valor": 25.00, "tipo": "${eGatilhoEntrada ? 'entrada' : 'saida'}"}
            `;

            let resultado = { eGasto: false };
            try {
                const respostaIA = await chamarComRetry(promptIA);
                if (respostaIA && respostaIA.text) {
                    let jsonLimpo = respostaIA.text.trim().replace(/```json/gi, '').replace(/```/g, '').trim();
                    const inicio = jsonLimpo.indexOf('{');
                    const fim = jsonLimpo.lastIndexOf('}');
                    if (inicio !== -1 && fim !== -1) jsonLimpo = jsonLimpo.substring(inicio, fim + 1);
                    resultado = JSON.parse(jsonLimpo);
                }
            } catch (errIA) {
                const numerosEncontrados = textoLimpo.match(/\d+([.,]\d+)?/);
                if (numerosEncontrados) {
                    const valExt = parseFloat(numerosEncontrados[0].replace(',', '.'));
                    let descExt = textoLimpo.replace(numerosEncontrados[0], '').replace(/reais|de|por|em/gi, '').trim();
                    resultado = {
                        eGasto: true,
                        descricao: descExt || (eGatilhoEntrada ? 'Entrada WhatsApp' : 'Gasto WhatsApp'),
                        valor: valExt,
                        tipo: eGatilhoEntrada ? 'entrada' : 'saida'
                    };
                }
            }

            if (eGatilhoEntrada) {
                resultado.tipo = 'entrada';
            }

            if (resultado.eGasto) {
                const valorNum = parseFloat(resultado.valor);

                if (resultado.tipo === 'entrada') {
                    await pool.query(
                        `INSERT INTO entradas (usuario_id, descricao, valor, data) VALUES ($1, $2, $3, $4)`,
                        [idUsuarioReal, resultado.descricao, valorNum, dataSimples]
                    );

                    await sock.sendMessage(remetenteRaw, {
                        text: `✅ *Entrada registrada no FinancIA!*\n💰 *Valor:* R$ ${valorNum.toFixed(2)}\n📝 *Descrição:* ${resultado.descricao}`
                    });
                } else {
                    const descNorm = resultado.descricao.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                    let cat = 'Compras';

                    if (
                        descNorm.includes('uber') || descNorm.includes('99') || descNorm.includes('posto') ||
                        descNorm.includes('gasolina') || descNorm.includes('combustivel') || descNorm.includes('moto') ||
                        descNorm.includes('mecanica') || descNorm.includes('oficina') || descNorm.includes('manutencao') ||
                        descNorm.includes('capacete') || descNorm.includes('pneu') || descNorm.includes('troca de oleo') ||
                        descNorm.includes('oleo') || descNorm.includes('pedagio') || descNorm.includes('estacionamento')
                    ) {
                        cat = 'Transporte';
                    } else if (
                        descNorm.includes('ifood') || descNorm.includes('restaurante') || descNorm.includes('lanche') ||
                        descNorm.includes('acai') || descNorm.includes('pizza') || descNorm.includes('cinema') ||
                        descNorm.includes('streaming') || descNorm.includes('jantar') || descNorm.includes('bar') ||
                        descNorm.includes('almoco') || descNorm.includes('almoço')
                    ) {
                        cat = 'Lazer';
                    } else if (
                        descNorm.includes('mercado') || descNorm.includes('supermercado') || descNorm.includes('agua pra beber') ||
                        descNorm.includes('padaria') || descNorm.includes('paes') || descNorm.includes('pao') || descNorm.includes('pão') ||
                        descNorm.includes('feira') || descNorm.includes('horti') || descNorm.includes('acougue') || descNorm.includes('atacadao')
                    ) {
                        cat = 'Mercado';
                    } else if (
                        descNorm.includes('luz') || descNorm.includes('agua') || descNorm.includes('internet') ||
                        descNorm.includes('enel') || descNorm.includes('cagece') || descNorm.includes('aluguel') ||
                        descNorm.includes('condominio') || descNorm.includes('acessorios')
                    ) {
                        cat = 'Casa';
                    }

                    await pool.query(
                        `INSERT INTO transacoes (usuario_id, descricao, valor, categoria, data) VALUES ($1, $2, $3, $4, $5)`,
                        [idUsuarioReal, resultado.descricao, valorNum, cat, dataSimples]
                    );

                    await sock.sendMessage(remetenteRaw, {
                        text: `📌 *Gasto registrado no FinancIA!*\n💸 *Valor:* R$ ${valorNum.toFixed(2)}\n🏷️ *Categoria:* ${cat}\n📝 *Descrição:* ${resultado.descricao}`
                    });
                }
            }
        } catch (err) {
            console.error("Erro no processamento do WhatsApp:", err.message);
        }
    });
}


app.get('/api/whatsapp/qr-code', autenticarToken, async (req, res) => {
    try {
        const usuarioId = req.usuario?.id || 1;

        if (!sessoesWhatsApp[usuarioId] || sessoesWhatsApp[usuarioId].status === 'desconectado') {
            iniciarBotUsuario(usuarioId);
            return res.json({
                status: 'aguardando',
                mensagem: 'Iniciando gerador de QR Code exclusivo... Tente em 3 segundos.'
            });
        }

        if (sessoesWhatsApp[usuarioId].status === 'conectado') {
            return res.json({
                status: 'conectado',
                mensagem: 'Seu WhatsApp já está conectado neste perfil!'
            });
        }

        if (!sessoesWhatsApp[usuarioId].qr) {
            return res.json({
                status: 'aguardando',
                mensagem: 'Gerando QR Code... Aguarde.'
            });
        }

        return res.json({
            status: 'pendente',
            qrcode: sessoesWhatsApp[usuarioId].qr
        });

    } catch (err) {
        console.error("❌ Erro na rota /api/whatsapp/qr-code:", err.message);
        return res.status(500).json({
            erro: "Erro interno ao gerar QR Code",
            detalhes: err.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 FinancIA Autônoma rodando na porta ${PORT}`);
});