const mysql = require('mysql2/promise');

const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS settings (
        name VARCHAR(64) PRIMARY KEY,
        value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS coins (
        symbol VARCHAR(20) PRIMARY KEY,
        type VARCHAR(10) NOT NULL,
        name VARCHAR(100) NOT NULL,
        quote VARCHAR(10) NOT NULL DEFAULT 'BRL',
        alert_up DECIMAL(24,8) NOT NULL DEFAULT 0,
        alert_down DECIMAL(24,8) NOT NULL DEFAULT 0,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        ref_value DECIMAL(24,8) NULL
    )`,
    `CREATE TABLE IF NOT EXISTS coin_history (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        symbol VARCHAR(20) NOT NULL,
        price DECIMAL(24,8) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_symbol_id (symbol, id),
        FOREIGN KEY (symbol) REFERENCES coins(symbol) ON DELETE CASCADE ON UPDATE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(64) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
        token_hash CHAR(64) PRIMARY KEY,
        user_id INT NOT NULL,
        expires_at DATETIME NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
];

async function connect() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER || 'botmoedas',
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'botmoedas',
        decimalNumbers: true,
        connectionLimit: 5,
    });

    try {
        for (const statement of SCHEMA) {
            await pool.query(statement);
        }
    } catch (error) {
        await pool.end();
        // Connection errors from mysql2 often have an empty message; say where we tried to connect instead.
        if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(error.code)) {
            const { host, port } = pool.pool.config.connectionConfig;
            throw new Error(`Não consegui conectar no MySQL em ${host}:${port} (${error.code}). O MySQL está rodando? Com Docker: docker compose up -d mysql`);
        }
        throw error;
    }

    return pool;
}

module.exports = { connect };
