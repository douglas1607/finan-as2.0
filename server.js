require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_JWT = process.env.JWT_SECRET || "financia_autonoma_chave_secreta_2026";

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Conexão com o Banco de Dados PostgreSQL na Nuvem (Neon/Supabase/Render)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Necessário para bancos PostgreSQL em nuvem
});

pool.connect((err) => {
    if (err) {
        console.error("❌ Erro ao conectar ao PostgreSQL:", err.message);
    } else {
        console.log("🐘 Banco de dados PostgreSQL conectado com sucesso!");
    }
});

// Criação automática das tabelas em sintaxe PostgreSQL
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
                preco_medio NUMERIC(10,2)
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

// ------------------- ROTAS -------------------

app.post('/api/cadastrar', async (req, res) => {
    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ erro: "Preencha todos os campos." });

    try {
        const hashSenha = bcrypt.hashSync(senha, 8);
        await pool.query(
            `INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3)`,
            [nome, email, hashSenha]
        );
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

app.get('/api/entradas', autenticarToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM entradas WHERE usuario_id = $1 ORDER BY id DESC`, [req.usuario.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ erro: "Erro ao buscar entradas." });
    }
});

app.post('/api/entradas', autenticarToken, async (req, res) => {
    const { descricao, valor } = req.body;
    const valNum = parseFloat(valor);
    if (!descricao || isNaN(valNum) || valNum <= 0) return res.status(400).json({ erro: "Dados inválidos." });

    const dataHoje = new Date().toLocaleDateString('pt-BR');
    try {
        const result = await pool.query(
            `INSERT INTO entradas (usuario_id, descricao, valor, data) VALUES ($1, $2, $3, $4) RETURNING id`,
            [req.usuario.id, descricao, valNum, dataHoje]
        );
        res.status(201).json({ id: result.rows[0].id, descricao, valor: valNum, data: dataHoje });
    } catch (err) {
        res.status(500).json({ erro: "Erro ao salvar entrada." });
    }
});

app.delete('/api/entradas/:id', autenticarToken, async (req, res) => {
    try {
        await pool.query(`DELETE FROM entradas WHERE id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id]);
        res.json({ mensagem: "Entrada removida com sucesso." });
    } catch (err) {
        res.status(500).json({ erro: "Erro ao excluir entrada." });
    }
});

app.get('/api/aportes', autenticarToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM aportes WHERE usuario_id = $1 ORDER BY id ASC`, [req.usuario.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ erro: "Erro ao buscar aportes." });
    }
});

app.post('/api/aportes', autenticarToken, async (req, res) => {
    const { mes, valor } = req.body;
    const valNum = parseFloat(valor);
    if (!mes || isNaN(valNum) || valNum <= 0) return res.status(400).json({ erro: "Dados inválidos." });

    const dataHoje = new Date().toLocaleDateString('pt-BR');
    try {
        const result = await pool.query(
            `INSERT INTO aportes (usuario_id, mes, valor, data) VALUES ($1, $2, $3, $4) RETURNING id`,
            [req.usuario.id, mes, valNum, dataHoje]
        );
        res.status(201).json({ id: result.rows[0].id, mes, valor: valNum, data: dataHoje });
    } catch (err) {
        res.status(500).json({ erro: "Erro ao salvar aporte." });
    }
});

app.get('/api/extrato', autenticarToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM transacoes WHERE usuario_id = $1 ORDER BY id DESC`, [req.usuario.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ erro: "Erro ao buscar extrato." });
    }
});

app.post('/api/transacao', autenticarToken, async (req, res) => {
    const { descricao, valor } = req.body;
    const valorNum = parseFloat(valor);
    if (!descricao || isNaN(valorNum) || valorNum <= 0) return res.status(400).json({ erro: "Dados inválidos." });

    let categoriaIA = "Lazer";
    const descLower = descricao.toLowerCase();

    if (descLower.includes('mercado') || descLower.includes('supermercado') || descLower.includes('compra semanal') || descLower.includes('feira') || descLower.includes('açougue')) {
        categoriaIA = 'Mercado';
    } else if (descLower.includes('obra') || descLower.includes('cimento') || descLower.includes('telha') || descLower.includes('tinta') || descLower.includes('construção') || descLower.includes('ferramenta')) {
        categoriaIA = 'Casa';
    } else {
        try {
            const prompt = `Responda com APENAS UMA PALAVRA EXATA entre "Mercado", "Casa" ou "Lazer".
- Se for supermercado, feira, alimentos, compras de casa de alimento, responda: Mercado
- Se for material de construção, reforma, obra, reparo de casa, responda: Casa
- Se for passeio, cinema, restaurante, bar, jogo, streaming, responda: Lazer

Compra: "${descricao}"`;
            const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
            if (response && response.text) {
                const resp = response.text.trim().toLowerCase();
                if (resp.includes('mercado')) categoriaIA = 'Mercado';
                else if (resp.includes('casa')) categoriaIA = 'Casa';
                else if (resp.includes('lazer')) categoriaIA = 'Lazer';
            }
        } catch (e) {
            console.error("Modo offline / erro na IA");
        }
    }

    const dataHoje = new Date().toLocaleDateString('pt-BR');
    try {
        const result = await pool.query(
            `INSERT INTO transacoes (usuario_id, descricao, valor, categoria, data) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [req.usuario.id, descricao, valorNum, categoriaIA, dataHoje]
        );
        res.status(201).json({ id: result.rows[0].id, descricao, valor: valorNum, categoria: categoriaIA, data: dataHoje });
    } catch (err) {
        res.status(500).json({ erro: "Erro ao salvar transação." });
    }
});

app.delete('/api/transacao/:id', autenticarToken, async (req, res) => {
    try {
        await pool.query(`DELETE FROM transacoes WHERE id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id]);
        res.json({ mensagem: "Transação removida com sucesso." });
    } catch (err) {
        res.status(500).json({ erro: "Erro ao excluir transação." });
    }
});

app.get('/api/gastos-fixos', autenticarToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM gastos_fixos WHERE usuario_id = $1 AND (pago = 0 OR pago IS NULL)`, [req.usuario.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ erro: "Erro ao buscar gastos fixos." });
    }
});

app.post('/api/gastos-fixos', autenticarToken, async (req, res) => {
    const { descricao, valor, vencimento } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO gastos_fixos (usuario_id, descricao, valor, vencimento, pago) VALUES ($1, $2, $3, $4, 0) RETURNING id`,
            [req.usuario.id, descricao, valor, vencimento]
        );
        res.status(201).json({ id: result.rows[0].id, descricao, valor, vencimento });
    } catch (err) {
        res.status(500).json({ erro: "Erro ao cadastrar conta fixa." });
    }
});

app.put('/api/gastos-fixos/:id/pago', autenticarToken, async (req, res) => {
    const gastoId = req.params.id;
    const usuarioId = req.usuario.id;

    try {
        const busca = await pool.query(`SELECT * FROM gastos_fixos WHERE id = $1 AND usuario_id = $2`, [gastoId, usuarioId]);
        const conta = busca.rows[0];
        if (!conta) return res.status(404).json({ erro: "Conta fixa não encontrada." });

        await pool.query(`UPDATE gastos_fixos SET pago = 1 WHERE id = $1 AND usuario_id = $2`, [gastoId, usuarioId]);

        const dataHoje = new Date().toLocaleDateString('pt-BR');
        await pool.query(
            `INSERT INTO transacoes (usuario_id, descricao, valor, categoria, data) VALUES ($1, $2, $3, $4, $5)`,
            [usuarioId, `[PAGO] ${conta.descricao}`, conta.valor, 'Casa', dataHoje]
        );

        res.json({ mensagem: "Pagamento registrado e abatido com sucesso!" });
    } catch (err) {
        res.status(500).json({ erro: "Erro ao dar baixa na conta." });
    }
});

app.delete('/api/gastos-fixos/:id', autenticarToken, async (req, res) => {
    try {
        await pool.query(`DELETE FROM gastos_fixos WHERE id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id]);
        res.json({ mensagem: "Gasto fixo removido com sucesso." });
    } catch (err) {
        res.status(500).json({ erro: "Erro ao excluir gasto fixo." });
    }
});

app.get('/api/ativos', autenticarToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM ativos_portfolio WHERE usuario_id = $1`, [req.usuario.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ erro: "Erro ao buscar ativos." });
    }
});

app.post('/api/ativos', autenticarToken, async (req, res) => {
    const { tipo, ticker, quantidade, preco_medio } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO ativos_portfolio (usuario_id, tipo, ticker, quantidade, preco_medio) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [req.usuario.id, tipo, ticker.toUpperCase(), quantidade, preco_medio]
        );
        res.status(201).json({ id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ erro: "Erro ao cadastrar ativo." });
    }
});

app.delete('/api/ativos/:id', autenticarToken, async (req, res) => {
    try {
        await pool.query(`DELETE FROM ativos_portfolio WHERE id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id]);
        res.json({ mensagem: "Ativo removido com sucesso." });
    } catch (err) {
        res.status(500).json({ erro: "Erro ao excluir ativo." });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 FinancIA Autônoma rodando na porta ${PORT}`);
});