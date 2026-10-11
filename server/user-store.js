"use strict";

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "dalmuti.db");

function createUserStore(dbPath = DB_PATH) {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  const insertUser = db.prepare(
    "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)"
  );
  const byUsername = db.prepare("SELECT * FROM users WHERE username = ?");
  const byId = db.prepare("SELECT id, username FROM users WHERE id = ?");

  return {
    db,
    // Returns the new user id, or null when the username is taken/invalid.
    register(username, password) {
      if (typeof username !== "string" || typeof password !== "string") return null;
      const name = username.trim();
      if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) return null;
      if (password.length < 8 || password.length > 200) return null;
      try {
        const hash = bcrypt.hashSync(password, 10);
        const info = insertUser.run(name, hash, Date.now());
        return info.lastInsertRowid;
      } catch (err) {
        if (String(err.message).includes("UNIQUE")) return null;
        throw err;
      }
    },
    verify(username, password) {
      if (typeof username !== "string" || typeof password !== "string") return null;
      const user = byUsername.get(username.trim());
      if (!user) return null;
      if (!bcrypt.compareSync(password, user.password_hash)) return null;
      return { id: user.id, username: user.username };
    },
    findById(id) {
      return byId.get(id) || null;
    },
    close() {
      db.close();
    },
  };
}

module.exports = { createUserStore, DB_PATH };
