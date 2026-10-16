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

async function limparAportes() {
    try {
        console.log("🔌 Conectando ao banco de dados para limpar os aportes...");
        
        // Executa o comando para apagar todos os registros da tabela aportes
        const resultado = await pool.query(`DELETE FROM aportes;`);
        
        console.log(`✅ Sucesso! Todos os aportes duplicados foram removidos do banco.`);
        console.log(`🗑️ Total de linhas afetadas/apagadas.`);
        
        // Opcional: Se quiser resetar o contador do ID da tabela para começar do 1 novamente:
        await pool.query(`ALTER SEQUENCE aportes_id_seq RESTART WITH 1;`);
        console.log(`🔄 Contador de IDs da tabela aportes reiniciado para 1.`);

    } catch (err) {
        console.error("❌ Erro ao limpar os aportes:", err.message);
    } finally {
        await pool.end();
        console.log("🔌 Conexão encerrada.");
    }
}

limparAportes();