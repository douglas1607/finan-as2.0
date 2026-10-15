require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function limparBanco() {
    try {
        console.log("🧹 Apagando transações de saída e entradas acumuladas...");
        
        // Limpa as saídas (despesas)
        await pool.query('DELETE FROM transacoes');
        
        // Limpa as entradas (receitas/salários)
        await pool.query('DELETE FROM entradas');
        
        console.log("✅ Tabelas de transações e entradas zeradas com sucesso!");
    } catch (err) {
        console.error("❌ Erro ao apagar:", err.message);
    } finally {
        await pool.end();
    }
}

limparBanco();