"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

const { configurePassport, loginHandler } = require("./server/auth");
const { createUserStore } = require("./server/user-store");
const { RoomManager } = require("./server/room-manager");

const PORT = process.env.PORT || 8080;
const NODE_ENV = process.env.NODE_ENV || "development";
// The account system is deprecated: on the free tier the filesystem is
// ephemeral, so accounts cannot persist. Default is guest-only; set
// AUTH_ENABLED=true (with persistent storage) to re-enable login.
const AUTH_ENABLED = String(process.env.AUTH_ENABLED).toLowerCase() === "true";
// A stable secret is only needed for signed session cookies, which exist only
// when auth is enabled. Requiring it otherwise would crash a guest-only deploy.
if (AUTH_ENABLED && NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production when AUTH_ENABLED is true");
}
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-insecure-secret";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function createServer(opts = {}) {
  const app = express();
  const httpServer = http.createServer(app);

  const authEnabled = opts.authEnabled != null ? opts.authEnabled : AUTH_ENABLED;
  // Only build the database-backed store when auth is on; guest mode needs none.
  const userStore = authEnabled ? opts.userStore || createUserStore(opts.dbPath) : null;
  const passport = authEnabled ? configurePassport(userStore) : null;

  // Render (and most PaaS) terminate TLS at a proxy and set X-Forwarded-For.
  // Trusting the first hop lets secure cookies and rate limiting see the real
  // client IP without triggering ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
  app.set("trust proxy", 1);

  // Sessions only matter for auth. Skipping them in guest mode avoids the
  // in-memory store (no cookie, no MemoryStore warning, less memory on free).
  const sessionMiddleware = authEnabled
    ? session({
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, sameSite: "lax", secure: NODE_ENV === "production" },
      })
    : null;

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            "https://ajax.googleapis.com",
            "https://cdnjs.cloudflare.com",
            "https://maxcdn.bootstrapcdn.com",
          ],
          styleSrc: [
            "'self'",
            "https://maxcdn.bootstrapcdn.com",
            "https://fonts.googleapis.com",
            "https://css.gg",
          ],
          fontSrc: ["'self'", "https://fonts.gstatic.com", "https://maxcdn.bootstrapcdn.com"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'", "ws:", "wss:"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use(express.json({ limit: "10kb" }));
  if (sessionMiddleware) {
    app.use(sessionMiddleware);
    app.use(passport.initialize());
    app.use(passport.session());
  }
  app.use(express.static(path.join(__dirname, "src")));

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true });

  // Render health check: cheap, unauthenticated, no session work.
  app.get("/healthz", (req, res) => res.status(200).json({ status: "ok" }));

  app.get("/", (req, res) => res.sendFile(path.join(__dirname, "src", "index.html")));
  app.get("/help", (req, res) => res.sendFile(path.join(__dirname, "src", "help.html")));
  app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "src", "login.html")));

  // Auth routes stay in place but no-op while the account system is disabled.
  const authDisabled = (req, res) =>
    res.status(403).json({ error: "Authentication is disabled", authEnabled: false });

  app.get("/api/me", (req, res) => {
    if (!authEnabled) return res.json({ authEnabled: false, username: null });
    if (req.isAuthenticated && req.isAuthenticated()) {
      return res.json({ authEnabled: true, id: req.user.id, username: req.user.username });
    }
    return res.status(401).json({ authEnabled: true, error: "Not authenticated" });
  });

  app.post("/api/register", authLimiter, (req, res, next) => {
    if (!authEnabled) return authDisabled(req, res);
    const { username, password } = req.body || {};
    const id = userStore.register(username, password);
    if (!id) return res.status(400).json({ error: "Invalid or taken username" });
    const user = { id, username: String(username).trim() };
    req.logIn(user, (err) => {
      if (err) return next(err);
      return res.status(201).json(user);
    });
  });

  app.post("/api/login", authLimiter, (req, res, next) => {
    if (!authEnabled) return authDisabled(req, res);
    return loginHandler(req, res, next);
  });

  app.post("/api/logout", (req, res) => {
    if (!authEnabled) return res.json({ ok: true });
    req.logout(() => res.json({ ok: true }));
  });

  app.get("/room/:roomName", (req, res, next) => {
    const rooms = manager.rooms;
    if (rooms.open[req.params.roomName] || rooms.hide[req.params.roomName]) {
      return res.sendFile(path.join(__dirname, "src", "room.html"));
    }
    return next();
  });

  app.use((req, res) => res.status(404).sendFile(path.join(__dirname, "src", "fourOfour.html")));

  // Error handler: never leak internals to the client.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error("ERROR:", err && err.message);
    res.status(err && err.status ? err.status : 500);
    res.sendFile(path.join(__dirname, "src", "fourOfour.html"));
  });

  const io = new Server(httpServer, {
    cors: {
      origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : false,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  // Share the Express session with Socket.io so socket.userId is trustworthy.
  if (sessionMiddleware) io.engine.use(sessionMiddleware);

  const manager = new RoomManager(io, { ...opts, userStore, requireAuth: authEnabled });

  io.on("connection", (socket) => {
    manager.attach(socket);
  });

  function close() {
    return new Promise((resolve) => {
      io.close(() => {
        if (userStore) userStore.close();
        resolve();
      });
    });
  }

  return { app, httpServer, io, manager, authEnabled, userStore, close };
}

if (require.main === module) {
  const server = createServer();
  server.httpServer.listen(PORT, () => console.log("Listening: " + PORT));
}

module.exports = { createServer };
