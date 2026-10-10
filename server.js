require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = 3000;
const SECRET_JWT = "financia_autonoma_chave_secreta_2026";

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const db = new sqlite3.Database('./financia.db', (err) => {
    if (err) console.error("Erro ao conectar ao SQLite:", err.message);
    else console.log("💾 Banco de dados SQLite 'financia.db' conectado com sucesso!");
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT,
        email TEXT UNIQUE,
        senha TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS transacoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        descricao TEXT,
        valor REAL,
        categoria TEXT,
        data TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS gastos_fixos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        descricao TEXT,
        valor REAL,
        vencimento TEXT
    )`);

    // Nova tabela para gerenciar o portfólio de ativos por quantidade e tipo
    db.run(`CREATE TABLE IF NOT EXISTS ativos_portfolio (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        tipo TEXT,
        ticker TEXT,
        quantidade REAL,
        preco_medio REAL
    )`);
});

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

app.post('/api/cadastrar', (req, res) => {
    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ erro: "Preencha todos os campos." });

    const hashSenha = bcrypt.hashSync(senha, 8);
    db.run(`INSERT INTO usuarios (nome, email, senha) VALUES (?, ?, ?)`, [nome, email, hashSenha], function(err) {
        if (err) return res.status(400).json({ erro: "E-mail já cadastrado no sistema." });
        res.status(201).json({ mensagem: "Conta criada com sucesso!" });
    });
});

app.post('/api/login', (req, res) => {
    const { email, senha } = req.body;
    db.get(`SELECT * FROM usuarios WHERE email = ?`, [email], (err, usuario) => {
        if (err || !usuario) return res.status(400).json({ erro: "Usuário ou senha incorretos." });

        const senhaValida = bcrypt.compareSync(senha, usuario.senha);
        if (!senhaValida) return res.status(400).json({ erro: "Usuário ou senha incorretos." });

        const token = jwt.sign({ id: usuario.id, nome: usuario.nome }, SECRET_JWT, { expiresIn: '24h' });
        res.json({ token, nome: usuario.nome });
    });
});

app.get('/api/extrato', autenticarToken, (req, res) => {
    db.all(`SELECT * FROM transacoes WHERE usuario_id = ? ORDER BY id DESC`, [req.usuario.id], (err, rows) => {
        if (err) return res.status(500).json({ erro: "Erro ao buscar extrato." });
        res.json(rows);
    });
});

app.post('/api/transacao', autenticarToken, async (req, res) => {
    const { descricao, valor } = req.body;
    const valorNum = parseFloat(valor);
    if (!descricao || isNaN(valorNum) || valorNum <= 0) return res.status(400).json({ erro: "Dados inválidos." });

    let categoriaIA = "Lazer";
    try {
        const prompt = `Classifique a compra em APENAS UMA palavra (Mercado, Casa ou Lazer):\nCompra: "${descricao}"`;
        const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
        
        if (response && response.text) {
            const resp = response.text.trim().toLowerCase();
            if (resp.includes('mercado')) categoriaIA = 'Mercado';
            else if (resp.includes('casa')) categoriaIA = 'Casa';
            else if (resp.includes('lazer')) categoriaIA = 'Lazer';
        }
    } catch (e) {
        console.error("Modo offline / erro no Gemini IA");
    }

    const dataHoje = new Date().toLocaleDateString('pt-BR');
    db.run(`INSERT INTO transacoes (usuario_id, descricao, valor, categoria, data) VALUES (?, ?, ?, ?, ?)`, 
        [req.usuario.id, descricao, valorNum, categoriaIA, dataHoje], function(err) {
            if (err) return res.status(500).json({ erro: "Erro ao salvar transação." });
            res.status(201).json({ id: this.lastID, descricao, valor: valorNum, categoria: categoriaIA, data: dataHoje });
    });
});

app.get('/api/gastos-fixos', autenticarToken, (req, res) => {
    db.all(`SELECT * FROM gastos_fixos WHERE usuario_id = ?`, [req.usuario.id], (err, rows) => {
        if (err) return res.status(500).json({ erro: "Erro ao buscar gastos fixos." });
        res.json(rows);
    });
});

app.post('/api/gastos-fixos', autenticarToken, (req, res) => {
    const { descricao, valor, vencimento } = req.body;
    db.run(`INSERT INTO gastos_fixos (usuario_id, descricao, valor, vencimento) VALUES (?, ?, ?, ?)`,
        [req.usuario.id, descricao, valor, vencimento], function(err) {
            if (err) return res.status(500).json({ erro: "Erro ao cadastrar conta fixa." });
            res.status(201).json({ id: this.lastID, descricao, valor, vencimento });
    });
});

// Rotas de Ativos do Portfólio
app.get('/api/ativos', autenticarToken, (req, res) => {
    db.all(`SELECT * FROM ativos_portfolio WHERE usuario_id = ?`, [req.usuario.id], (err, rows) => {
        if (err) return res.status(500).json({ erro: "Erro ao buscar ativos." });
        res.json(rows);
    });
});

app.post('/api/ativos', autenticarToken, (req, res) => {
    const { tipo, ticker, quantidade, preco_medio } = req.body;
    db.run(`INSERT INTO ativos_portfolio (usuario_id, tipo, ticker, quantidade, preco_medio) VALUES (?, ?, ?, ?, ?)`,
        [req.usuario.id, tipo, ticker.toUpperCase(), quantidade, preco_medio], function(err) {
            if (err) return res.status(500).json({ erro: "Erro ao cadastrar ativo." });
            res.status(201).json({ id: this.lastID });
    });
});

app.delete('/api/ativos/:id', autenticarToken, (req, res) => {
    db.run(`DELETE FROM ativos_portfolio WHERE id = ? AND usuario_id = ?`, [req.params.id, req.usuario.id], function(err) {
        if (err) return res.status(500).json({ erro: "Erro ao excluir ativo." });
        res.json({ mensagem: "Ativo removido com sucesso." });
    });
});

app.listen(PORT, () => {
    console.log(`🚀 FinancIA Autônoma rodando em http://localhost:${PORT}`);
});