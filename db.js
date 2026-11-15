require("dotenv").config();

const { Pool } = require("pg");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL_POOLED ||
    process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

pool.on("error", (error) => {
  console.error("Unexpected database error:", error.message);
});

module.exports = pool;

