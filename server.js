require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { GoogleGenAI } = require('@google/genai');
const multer = require('multer');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCodeLib = require('qrcode');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_JWT = process.env.JWT_SECRET || "financia_autonoma_chave_secreta_2026";

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
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
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

async function inicializarTabelas() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id SERIAL PRIMARY KEY,
                nome VARCHAR(255),
                email VARCHAR(255) UNIQUE,
                senha VARCHAR(255)
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
                quantidade NUMERIC(10,4),
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
                mes VARCHAR(50),
                valor NUMERIC(10,2),
                data VARCHAR(50)
            );
        `);
        await pool.query(`ALTER TABLE ativos_portfolio ADD COLUMN IF NOT EXISTS data_compra VARCHAR(50);`);
        console.log("✅ Tabelas PostgreSQL verificadas/criadas com sucesso!");
    } catch (e) {
        console.error("Erro ao inicializar tabelas:", e.message);
    }
}
inicializarTabelas();

// Modelos atualizados do Gemini API
const MODELOS_DISPONIVEIS = [
    'gemini-3.8-flash',
    'gemini-2.5-flash',
    'gemini-2.0-flash'
];

async function chamarComRetry(prompt) {
    let ultimoErro = null;

    for (const modelo of MODELOS_DISPONIVEIS) {
        for (let tentativa = 1; tentativa <= 2; tentativa++) {
            try {
                const response = await ai.models.generateContent({
                    model: modelo,
                    contents: prompt
                });
                return response;
            } catch (err) {
                ultimoErro = err;
                console.warn(`⚠️ Falha no modelo ${modelo} (tentativa ${tentativa}): ${err.message}`);
                if (err.message.includes('503') || err.message.includes('UNAVAILABLE') || err.message.includes('429')) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else {
                    break; 
                }
            }
        }
    }
    throw ultimoErro;
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
    const dataHoje = new Date().toLocaleDateString('pt-BR');
    try {
        const result = await pool.query(`INSERT INTO aportes (usuario_id, mes, valor, data) VALUES ($1, $2, $3, $4) RETURNING id`, [req.usuario.id, mes, valNum, dataHoje]);
        res.status(201).json({ id: result.rows[0].id, mes, valor: valNum, data: dataHoje });
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

    const descNorm = descricao.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    let categoriaIA = "Compras";

    if (descNorm.includes('gasolina') || descNorm.includes('combustivel') || descNorm.includes('uber') || descNorm.includes('99') || descNorm.includes('pedagio')) {
        categoriaIA = 'Transporte';
    } else if (descNorm.includes('acai') || descNorm.includes('lanche') || descNorm.includes('restaurante') || descNorm.includes('ifood') || descNorm.includes('pizza')) {
        categoriaIA = 'Lazer';
    } else if (descNorm.includes('mercado') || descNorm.includes('supermercado') || descNorm.includes('feira') || descNorm.includes('padaria')) {
        categoriaIA = 'Mercado';
    } else if (descNorm.includes('aluguel') || descNorm.includes('condominio') || descNorm.includes('luz') || descNorm.includes('agua') || descNorm.includes('internet')) {
        categoriaIA = 'Casa';
    }

    const dataHoje = new Date().toLocaleDateString('pt-BR');
    try {
        const result = await pool.query(
            `INSERT INTO transacoes (usuario_id, descricao, valor, categoria, data) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [req.usuario.id, descricao, valorNum, categoriaIA, dataHoje]
        );
        res.status(201).json({ id: result.rows[0].id, descricao, valor: valorNum, categoria: categoriaIA, data: dataHoje });
    } catch (err) { res.status(500).json({ erro: "Erro ao salvar transação." }); }
});

app.delete('/api/transacao/:id', autenticarToken, async (req, res) => {
    try {
        await pool.query(`DELETE FROM transacoes WHERE id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id]);
        res.json({ mensagem: "Transação removida." });
    } catch (err) { res.status(500).json({ erro: "Erro ao excluir transação." }); }
});

// Nova rota adicionada para importar extratos (PDF convertidos, TXT ou OFX)
app.post('/api/importar-ofx', autenticarToken, upload.single('arquivoOfx'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ erro: "Nenhum arquivo enviado." });
        }

        const conteudoArquivo = req.file.buffer.toString('utf8');
        const usuarioId = req.usuario.id;
        const dataHoje = new Date().toLocaleDateString('pt-BR');

        const prompt = `
        Analise o texto do extrato bancário abaixo e extraia todas as transações de gastos/despesas encontrados.
        Texto do extrato:
        """
        ${conteudoArquivo}
        """

        Responda EXATAMENTE e APENAS um JSON contendo um array de objetos com o formato abaixo (sem marcadores markdown):
        [
          {"descricao": "Supermercado Extra", "valor": 150.50, "categoria": "Mercado"},
          {"descricao": "Posto Ipiranga", "valor": 100.00, "categoria": "Transporte"}
        ]
        Categorias permitidas: Mercado, Casa, Lazer, Transporte, Compras. Se não tiver certeza, use Compras.
        `;

        const respostaIA = await chamarComRetry(prompt);
        let jsonLimpo = respostaIA.text.trim().replace(/```json/gi, '').replace(/```/g, '').trim();
        const inicio = jsonLimpo.indexOf('[');
        const fim = jsonLimpo.lastIndexOf(']');
        if (inicio !== -1 && fim !== -1) jsonLimpo = jsonLimpo.substring(inicio, fim + 1);

        const transacoesExtraidas = JSON.parse(jsonLimpo);

        if (!Array.isArray(transacoesExtraidas) || transacoesExtraidas.length === 0) {
            return res.status(400).json({ erro: "Não foi possível identificar transações válidas neste arquivo." });
        }

        for (let t of transacoesExtraidas) {
            const desc = t.descricao || 'Despesa Importada';
            const val = parseFloat(t.valor) || 0;
            const cat = t.categoria || 'Compras';

            if (val > 0) {
                await pool.query(
                    `INSERT INTO transacoes (usuario_id, descricao, valor, categoria, data) VALUES ($1, $2, $3, $4, $5)`,
                    [usuarioId, desc, val, cat, dataHoje]
                );
            }
        }

        res.json({ mensagem: `✅ ${transacoesExtraidas.length} transações importadas e categorizadas com sucesso!` });
    } catch (err) {
        console.error("Erro na importação:", err);
        res.status(500).json({ erro: "Erro ao processar arquivo de extrato." });
    }
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

// ==========================================================
// GESTÃO MULTI-SESSÃO WHATSAPP POR USUÁRIO (BAILEYS ISOLADO)
// ==========================================================
const sessoesWhatsApp = {};

async function iniciarBotUsuario(usuarioId) {
    if (sessoesWhatsApp[usuarioId]?.sock && sessoesWhatsApp[usuarioId]?.status === 'conectado') {
        return;
    }

    const pastaAuth = path.join(__dirname, `auth_info_usuario_${usuarioId}`);
    const { state, saveCreds } = await useMultiFileAuthState(pastaAuth);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        markOnlineOnConnect: true
    });

    sessoesWhatsApp[usuarioId] = { sock, status: 'iniciando', qr: '' };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessoesWhatsApp[usuarioId].status = 'aguardando_qr';
            sessoesWhatsApp[usuarioId].qr = await QRCodeLib.toDataURL(qr);
            console.log(`🔄 QR Code gerado para o Usuário ID ${usuarioId}`);
        }

        if (connection === 'close') {
            sessoesWhatsApp[usuarioId].status = 'desconectado';
            sessoesWhatsApp[usuarioId].qr = '';
            const shouldReconnect = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
            if (shouldReconnect) {
                setTimeout(() => iniciarBotUsuario(usuarioId), 3000);
            }
        } else if (connection === 'open') {
            sessoesWhatsApp[usuarioId].status = 'conectado';
            sessoesWhatsApp[usuarioId].qr = '';
            console.log(`🚀 WhatsApp conectado com sucesso para o Usuário ID ${usuarioId}!`);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg || !msg.message) return;

            const remetenteRaw = msg.key.remoteJid;
            const textoMensagem = (
                msg.message.conversation || 
                msg.message.extendedTextMessage?.text || 
                msg.message.imageMessage?.caption || 
                ''
            ).trim();

            if (!textoMensagem) return;

            const textoMinusculo = textoMensagem.toLowerCase();
            const gatilhos = ['!', '/', 'gasto', 'paguei', 'comprei', 'entrada', 'recebi', 'ganhei', 'vendi'];
            
            const temGatilho = gatilhos.some(g => textoMinusculo.startsWith(g));
            if (!temGatilho) return;

            const eGatilhoEntrada = ['entrada', 'recebi', 'ganhei', 'vendi'].some(g => textoMinusculo.startsWith(g));

            let textoLimpo = textoMensagem;
            gatilhos.forEach(g => {
                if (textoLimpo.toLowerCase().startsWith(g)) {
                    textoLimpo = textoLimpo.slice(g.length).trim();
                }
            });

            console.log(`💬 Comando financeiro recebido do Usuário ID ${usuarioId}: "${textoLimpo}" (Tipo detectado: ${eGatilhoEntrada ? 'Entrada' : 'Gasto'})`);

            const promptIA = `
            Analise a mensagem financeira abaixo e extraia a descrição, valor e tipo.
            Mensagem: "${textoLimpo}"

            Responda EXATAMENTE e APENAS um JSON no formato abaixo (sem marcadores markdown):
            {"eGasto": true, "descricao": "Venda de dindin", "valor": 25.00, "tipo": "${eGatilhoEntrada ? 'entrada' : 'saida'}"}

            Regras:
            - Se o tipo indicado for "entrada" ou se a mensagem for de vendas/recebimentos/PIX/salário, use "tipo": "entrada".
            - Se for compra, pagamento ou despesa, use "tipo": "saida".
            - Se não for registro financeiro, responda: {"eGasto": false}
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
                const dataHoje = new Date().toLocaleDateString('pt-BR');

                if (resultado.tipo === 'entrada') {
                    await pool.query(
                        `INSERT INTO entradas (usuario_id, descricao, valor, data) VALUES ($1, $2, $3, $4)`,
                        [usuarioId, resultado.descricao, valorNum, dataHoje]
                    );
                    
                    await sock.sendMessage(remetenteRaw, { 
                        text: `✅ *Entrada registrada no FinancIA!*\n💰 *Valor:* R$ ${valorNum.toFixed(2)}\n📝 *Descrição:* ${resultado.descricao}` 
                    });
                } else {
                    const descNorm = resultado.descricao.toLowerCase();
                    let cat = 'Compras';
                    if (descNorm.includes('mercado') || descNorm.includes('padaria') || descNorm.includes('feira')) cat = 'Mercado';
                    else if (descNorm.includes('gasolina') || descNorm.includes('uber') || descNorm.includes('combustivel')) cat = 'Transporte';
                    else if (descNorm.includes('ifood') || descNorm.includes('lanche') || descNorm.includes('restaurante') || descNorm.includes('pizza')) cat = 'Lazer';
                    else if (descNorm.includes('aluguel') || descNorm.includes('luz') || descNorm.includes('agua') || descNorm.includes('internet')) cat = 'Casa';

                    await pool.query(
                        `INSERT INTO transacoes (usuario_id, descricao, valor, categoria, data) VALUES ($1, $2, $3, $4, $5)`,
                        [usuarioId, resultado.descricao, valorNum, cat, dataHoje]
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

// Rota para o usuário obter o QR Code do SEU perfil
app.get('/api/whatsapp/qr-code', autenticarToken, async (req, res) => {
    const usuarioId = req.usuario.id;

    if (!sessoesWhatsApp[usuarioId] || sessoesWhatsApp[usuarioId].status === 'desconectado') {
        iniciarBotUsuario(usuarioId);
        return res.json({ status: 'aguardando', mensagem: 'Iniciando gerador de QR Code exclusivo... Tente em 3 segundos.' });
    }

    if (sessoesWhatsApp[usuarioId].status === 'conectado') {
        return res.json({ status: 'conectado', mensagem: 'Seu WhatsApp já está conectado neste perfil!' });
    }

    if (!sessoesWhatsApp[usuarioId].qr) {
        return res.json({ status: 'aguardando', mensagem: 'Gerando QR Code... Aguarde.' });
    }

    res.json({ status: 'pendente', qrcode: sessoesWhatsApp[usuarioId].qr });
});

app.listen(PORT, () => {
    console.log(`🚀 FinancIA Autônoma rodando na porta ${PORT}`);
});