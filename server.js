require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { GoogleGenAI } = require('@google/genai');
const multer = require('multer');
const ofx = require('ofx-data-extractor');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_JWT = process.env.JWT_SECRET || "financia_autonoma_chave_secreta_2026";

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// ==========================================================
// SERVIR ARQUIVOS ESTÁTICOS E PÁGINA INICIAL (PWA / FRONTEND)
// ==========================================================
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

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

// Rotas Entradas
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

// Rotas Aportes
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

// Rotas Transações / Extrato & IA (Categorização com Sistema Completo)
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

    const descNorm = descricao
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

    let categoriaIA = "";

    if (descNorm.includes('gasolina') || descNorm.includes('combustivel') || descNorm.includes('etanol') || descNorm.includes('diesel') || descNorm.includes('uber') || descNorm.includes('99') || descNorm.includes('taxi') || descNorm.includes('pedagio') || descNorm.includes('estacionamento') || descNorm.includes('mecanico') || descNorm.includes('troca de oleo')) {
        categoriaIA = 'Transporte';
    } else if (descNorm.includes('acai') || descNorm.includes('lanche') || descNorm.includes('restaurante') || descNorm.includes('ifood') || descNorm.includes('pizza') || descNorm.includes('churrasco') || descNorm.includes('cerveja') || descNorm.includes('cinema') || descNorm.includes('sorvete') || descNorm.includes('sushi') || descNorm.includes('hamburguer')) {
        categoriaIA = 'Lazer';
    } else if (descNorm.includes('mercado') || descNorm.includes('supermercado') || descNorm.includes('feira') || descNorm.includes('padaria') || descNorm.includes('acougue') || descNorm.includes('hortifruti') || descNorm.includes('sacolao')) {
        categoriaIA = 'Mercado';
    } else if (descNorm.includes('obra') || descNorm.includes('cimento') || descNorm.includes('telha') || descNorm.includes('tinta') || descNorm.includes('aluguel') || descNorm.includes('condominio') || descNorm.includes('maquina de lavar') || descNorm.includes('geladeira') || descNorm.includes('moveis')) {
        categoriaIA = 'Casa';
    } else if (descNorm.includes('roupa') || descNorm.includes('sapato') || descNorm.includes('tenis') || descNorm.includes('bicicleta') || descNorm.includes('celular') || descNorm.includes('camisa') || descNorm.includes('calca')) {
        categoriaIA = 'Compras';
    }

    if (!categoriaIA) {
        try {
            const prompt = `Sua função é classificar o gasto "${descricao}" EXATAMENTE em uma das 5 categorias abaixo:
            - Mercado: Compras em supermercados, atacadões, padarias, feiras livre, açougues, hortifruti, mantimentos e comida para preparar em casa.
            - Casa: Contas de água, luz, internet, gás, aluguel, condomínio, materiais de construção (cimento, tintas, reformas), eletrodomésticos, móveis, utilidades domésticas e ração de pets.
            - Lazer: Alimentação fora de casa (restaurantes, açaí, iFood, lanches, pizzas, sushi, bares, cervejas), cinema, passeios, viagens, ingressos e assinaturas como Netflix/Spotify.
            - Transporte: Combustíveis (gasolina, etanol, diesel), corridas (Uber, 99, táxi), manutenção de veículos, pneus, mecânico, pedágio, estacionamento e passagens de ônibus/metrô.
            - Compras: Vestuário (roupas, sapatos, tênis, bijuterias), eletrônicos, celulares, computadores, bicicletas, presentes, itens de uso pessoal e compras diversas.
            Responda APENAS com uma destas 5 palavras exatas sem explicações: Mercado, Casa, Lazer, Transporte ou Compras.`;

            const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
            if (response && response.text) {
                const resp = response.text.trim();
                const validas = ['Mercado', 'Casa', 'Lazer', 'Transporte', 'Compras'];
                categoriaIA = validas.includes(resp) ? resp : 'Compras';
            } else {
                categoriaIA = 'Compras';
            }
        } catch (e) {
            categoriaIA = 'Compras';
        }
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

// Rota Universal de Importação (Aceita OFX, CSV, TXT e o texto do PDF vindo do Frontend)
app.post('/api/importar-ofx', autenticarToken, upload.single('arquivoOfx'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ erro: 'Nenhum arquivo de extrato enviado.' });
        }

        const conteudoTexto = req.file.buffer.toString('utf8');
        let transacoesParaProcessar = [];

        // Tenta ler primeiro como OFX estruturado
        try {
            const dadosParseados = ofx.parse(conteudoTexto);
            const listaOFX = dadosParseados.bankTransactionList || [];
            transacoesParaProcessar = listaOFX.map(t => ({
                descricao: t.MEMO || t.NAME || 'Transação Bancária',
                valor: parseFloat((t.TRNAMT || '0').replace(',', '.')),
                data: t.DTPOSTED ? `${t.DTPOSTED.substring(6,8)}/${t.DTPOSTED.substring(4,6)}/${t.DTPOSTED.substring(0,4)}` : new Date().toLocaleDateString('pt-BR')
            }));
        } catch (e) {
            // Se não for OFX estruturado (ex: o texto extraído do PDF ou TXT/CSV), usa a Inteligência Artificial do Gemini para ler o conteúdo!
            try {
                const promptIA = `
                Você é um extrator financeiro inteligente. Analise o texto deste extrato bancário abaixo.
                Extraia TODAS as transações financeiras e retorne estritamente um array JSON puro (sem crases, sem markdown, sem texto adicional).
                Cada item do array deve ter exatamente estas chaves:
                - "descricao": string clara com o nome da transação
                - "valor": número (positivo para entradas/Pix recebido/salário, negativo para saídas/compras/pagamentos)
                - "data": string no formato DD/MM/AAAA

                Texto do Extrato:
                ${conteudoTexto}

                Exemplo de formato esperado:
                [
                  {"descricao": "Pix Recebido", "valor": 150.00, "data": "10/10/2026"},
                  {"descricao": "Supermercado Moranguinho", "valor": -85.50, "data": "11/10/2026"}
                ]
                `;

                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: promptIA
                });

                if (response && response.text) {
                    let textoResposta = response.text.trim();
                    textoResposta = textoResposta.replace(/```json/gi, '').replace(/```/g, '').trim();
                    
                    const inicio = textoResposta.indexOf('[');
                    const fim = textoResposta.lastIndexOf(']');
                    if (inicio !== -1 && fim !== -1) {
                        textoResposta = textoResposta.substring(inicio, fim + 1);
                    }

                    transacoesParaProcessar = JSON.parse(textoResposta);
                }
            } catch (errIA) {
                console.error("Erro na IA ao ler extrato:", errIA);
            }
        }

        if (!transacoesParaProcessar || transacoesParaProcessar.length === 0) {
            return res.status(400).json({ erro: 'Não foi possível identificar transações válidas neste arquivo.' });
        }

        let importadosCount = 0;

        for (let item of transacoesParaProcessar) {
            const valorNum = parseFloat(item.valor);
            const descricao = item.descricao || 'Movimentação Bancária';
            const dataFormatada = item.data || new Date().toLocaleDateString('pt-BR');

            if (isNaN(valorNum)) continue;

            if (valorNum > 0) {
                await pool.query(
                    'INSERT INTO entradas (usuario_id, descricao, valor, data) VALUES ($1, $2, $3, $4)',
                    [req.usuario.id, descricao, valorNum, dataFormatada]
                );
            } else {
                const valorPositivo = Math.abs(valorNum);
                const descNorm = descricao.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                let categoriaIA = "Compras";

                if (descNorm.includes('gasolina') || descNorm.includes('combustivel') || descNorm.includes('etanol') || descNorm.includes('diesel') || descNorm.includes('uber') || descNorm.includes('99') || descNorm.includes('taxi') || descNorm.includes('pedagio')) {
                    categoriaIA = 'Transporte';
                } else if (descNorm.includes('acai') || descNorm.includes('lanche') || descNorm.includes('restaurante') || descNorm.includes('ifood') || descNorm.includes('pizza') || descNorm.includes('churrasco') || descNorm.includes('cerveja') || descNorm.includes('sorvete') || descNorm.includes('sushi')) {
                    categoriaIA = 'Lazer';
                } else if (descNorm.includes('mercado') || descNorm.includes('supermercado') || descNorm.includes('feira') || descNorm.includes('padaria') || descNorm.includes('acougue') || descNorm.includes('hortifruti')) {
                    categoriaIA = 'Mercado';
                } else if (descNorm.includes('aluguel') || descNorm.includes('condominio') || descNorm.includes('luz') || descNorm.includes('agua') || descNorm.includes('internet') || descNorm.includes('reforma') || descNorm.includes('cimento')) {
                    categoriaIA = 'Casa';
                }

                await pool.query(
                    'INSERT INTO transacoes (usuario_id, descricao, valor, categoria, data) VALUES ($1, $2, $3, $4, $5)',
                    [req.usuario.id, descricao, valorPositivo, categoriaIA, dataFormatada]
                );
            }
            importadosCount++;
        }

        return res.json({ 
            sucesso: true, 
            mensagem: `✨ ${importadosCount} movimentações importadas e categorizadas com sucesso!` 
        });

    } catch (err) {
        console.error("Erro geral ao processar extrato:", err);
        return res.status(500).json({ erro: 'Erro interno ao ler e processar o extrato enviado.' });
    }
});

// Rotas Gastos Fixos
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

// Rotas Ativos / Portfólio
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

    if (tipo === 'Acoes' && (tickerLimpo.endsWith('11') || tickerLimpo.endsWith('11B'))) {
        tipoFinal = 'FIIs';
    }

    const dataFinal = data_compra || new Date().toLocaleDateString('pt-BR');

    try {
        const result = await pool.query(
            `INSERT INTO ativos_portfolio (usuario_id, tipo, ticker, quantidade, preco_medio, data_compra) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [req.usuario.id, tipoFinal, tickerLimpo, qtdNum, precoNum, dataFinal]
        );
        res.status(201).json({ id: result.rows[0].id, mensagem: "Ativo cadastrado com sucesso!" });
    } catch (err) {
        console.error("Erro ao cadastrar ativo:", err);
        res.status(500).json({ erro: "Erro ao cadastrar ativo no banco de dados." });
    }
});

app.delete('/api/ativos/:id', autenticarToken, async (req, res) => {
    try {
        await pool.query(`DELETE FROM ativos_portfolio WHERE id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id]);
        res.json({ mensagem: "Ativo removido." });
    } catch (err) { res.status(500).json({ erro: "Erro ao excluir ativo." }); }
});

app.listen(PORT, () => {
    console.log(`🚀 FinancIA Autônoma rodando na porta ${PORT}`);
});