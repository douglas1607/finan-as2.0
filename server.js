require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCodeLib = require('qrcode');
const fs = require('fs');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_JWT = process.env.JWT_SECRET || "financia_autonoma_chave_secreta_2026";

// 🌐 URL DO WEBHOOK DO SEU N8N
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "https://maikom.app.n8n.cloud/webhook/financia-processar";

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
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS grupo_id VARCHAR(255);`);
        await pool.query(`ALTER TABLE ativos_portfolio ADD COLUMN IF NOT EXISTS data_compra VARCHAR(50);`);
        await pool.query(`ALTER TABLE ativos_portfolio ALTER COLUMN quantidade TYPE NUMERIC(15,8);`);
        console.log("✅ Tabelas PostgreSQL verificadas/criadas com sucesso!");
    } catch (e) {
        console.error("Erro ao inicializar tabelas:", e.message);
    }
}
inicializarTabelas();

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
        const resultado = await pool.query('SELECT id, nome, email, grupo_id FROM usuarios ORDER BY id ASC');
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

// Rotas de Transações e Extrato
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
        descNorm.includes('mecanica') || descNorm.includes('oficina') || descNorm.includes('manutencao')
    ) {
        categoria = 'Transporte';
    } else if (
        descNorm.includes('ifood') || descNorm.includes('restaurante') || descNorm.includes('lanche') ||
        descNorm.includes('acai') || descNorm.includes('pizza') || descNorm.includes('cinema') ||
        descNorm.includes('streaming') || descNorm.includes('jantar') || descNorm.includes('bar')
    ) {
        categoria = 'Lazer';
    } else if (
        descNorm.includes('mercado') || descNorm.includes('supermercado') || descNorm.includes('padaria') ||
        descNorm.includes('paes') || descNorm.includes('feira') || descNorm.includes('horti') || descNorm.includes('acougue')
    ) {
        categoria = 'Mercado';
    } else if (
        descNorm.includes('luz') || descNorm.includes('agua') || descNorm.includes('internet') ||
        descNorm.includes('enel') || descNorm.includes('cagece') || descNorm.includes('aluguel')
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

// 📥 Rota de Importação OFX mantida integralmente
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
                    else if (dL.includes('uber') || dL.includes('99') || dL.includes('posto')) cat = 'Transporte';
                    else if (dL.includes('ifood') || dL.includes('jantar')) cat = 'Lazer';
                    else if (dL.includes('luz') || dL.includes('agua') || dL.includes('internet')) cat = 'Casa';

                    const chave = `${descLimpa}_${valNum}`;
                    if (!mapUnicas.has(chave)) {
                        mapUnicas.set(chave, { descricao: descLimpa.slice(0, 50), valor: valNum, tipo: 'saida', categoria: cat });
                    }
                }
            }
        }
        const transacoesExtraidas = Array.from(mapUnicas.values());

        if (transacoesExtraidas.length === 0) {
            return res.status(400).json({ erro: "Nenhuma transação válida identificada." });
        }

        let qtdSaidas = 0;
        let qtdEntradas = 0;

        for (let t of transacoesExtraidas) {
            await pool.query(`INSERT INTO transacoes (usuario_id, descricao, valor, categoria, data) VALUES ($1, $2, $3, $4, $5)`, [usuarioId, t.descricao, t.valor, t.categoria, dataHoje]);
            qtdSaidas++;
        }

        res.json({ mensagem: `✅ Extrato importado com sucesso: ${qtdSaidas} saídas cadastradas!` });
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

// Rotas de Gastos Fixos e Ativos
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

app.delete('/api/gastos-fixos/:id', autenticarToken, async (req, res) => {
    try {
        await pool.query(`DELETE FROM gastos_fixos WHERE id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id]);
        res.json({ mensagem: "Gasto fixo removido." });
    } catch (err) { res.status(500).json({ erro: "Erro ao excluir." }); }
});

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
// SESSÕES WHATSAPP & WEBHOOK N8N
// ==========================================
const sessoesWhatsApp = {};

async function iniciarBotUsuario(usuarioId) {
    if (sessoesWhatsApp[usuarioId]?.sock && sessoesWhatsApp[usuarioId]?.status === 'conectado') {
        return;
    }

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
                } else {
                    const meuNumeroJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                    const resGrupo = await sock.groupCreate("FinancIA - Gestão Financeira", [meuNumeroJid]);
                    targetGroupId = resGrupo.id;

                    await new Promise(resolve => setTimeout(resolve, 3000));
                    const caminhoFoto = path.join(__dirname, 'icon.png');
                    if (fs.existsSync(caminhoFoto)) {
                        try {
                            const bufferFoto = fs.readFileSync(caminhoFoto);
                            await sock.updateProfilePicture(targetGroupId, bufferFoto);
                        } catch (errFoto) { }
                    }

                    const mensagemBoasVindas = `👋 *Bem-vindo ao FinancIA Autônoma!*\n\nEste é o seu grupo exclusivo para registro de gastos, entradas e investimentos. Envie comandos por texto, foto ou PDF!`;
                    await sock.sendMessage(targetGroupId, { text: mensagemBoasVindas });
                }

                sessoesWhatsApp[usuarioId].grupoId = targetGroupId;
                await pool.query(`UPDATE usuarios SET grupo_id = $1 WHERE id = $2`, [targetGroupId, usuarioId]);

            } catch (errGrupo) {
                console.error(`ℹ️ Erro no gerenciamento de grupo:`, errGrupo.message);
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg || !msg.message) return;

            const remetenteRaw = msg.key.remoteJid;
            if (!remetenteRaw.endsWith('@g.us')) return;

            const grupoOficialSalvo = sessoesWhatsApp[usuarioId]?.grupoId;
            if (grupoOficialSalvo && remetenteRaw !== grupoOficialSalvo) return;

            const textoChecagem = (
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.documentMessage?.caption ||
                ''
            ).trim();

            if (msg.key.fromMe && textoChecagem.includes('Registrado')) return;

            let imagemBase64 = null;
            if (msg.message.imageMessage) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    imagemBase64 = buffer.toString('base64');
                } catch (e) { }
            }

            try {
                const payloadN8N = {
                    usuarioId: usuarioId,
                    texto: textoChecagem,
                    imagemBase64: imagemBase64,
                    remetenteJid: remetenteRaw
                };

                console.log(`📤 A enviar mensagem do WhatsApp para o n8n (${N8N_WEBHOOK_URL})...`);

                const respostaN8N = await fetch(N8N_WEBHOOK_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payloadN8N)
                });

                const respostaTexto = await respostaN8N.text();
                console.log(`📥 Resposta do n8n (Status ${respostaN8N.status}):`, respostaTexto);

                if (respostaN8N.ok && respostaTexto) {
                    const dadosProcessados = JSON.parse(respostaTexto);
                    if (dadosProcessados?.mensagemResposta) {
                        await sock.sendMessage(remetenteRaw, { text: dadosProcessados.mensagemResposta });
                    }
                }
            } catch (err) {
                console.error("❌ Erro crítico ao enviar dados para o n8n:", err.message);
            }

            if (respostaN8N.ok) {
                const dadosProcessados = await respostaN8N.json();
                if (dadosProcessados?.mensagemResposta) {
                    await sock.sendMessage(remetenteRaw, { text: dadosProcessados.mensagemResposta });
                }
            }

        } catch (err) {
            console.error("Erro ao enviar dados para o n8n:", err.message);
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