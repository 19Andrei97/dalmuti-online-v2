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
// In production a real secret is mandatory; in development fall back to a fixed
// value so local runs work without configuration.
if (NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production");
}
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-insecure-secret";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function createServer(opts = {}) {
  const app = express();
  const httpServer = http.createServer(app);

  const userStore = opts.userStore || createUserStore(opts.dbPath);
  const passport = configurePassport(userStore);
  const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: NODE_ENV === "production" },
  });

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
  app.use(sessionMiddleware);
  app.use(passport.initialize());
  app.use(passport.session());
  app.use(express.static(path.join(__dirname, "src")));

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true });

  app.get("/", (req, res) => res.sendFile(path.join(__dirname, "src", "index.html")));
  app.get("/help", (req, res) => res.sendFile(path.join(__dirname, "src", "help.html")));
  app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "src", "login.html")));

  app.get("/api/me", (req, res) => {
    if (req.isAuthenticated && req.isAuthenticated()) {
      return res.json({ id: req.user.id, username: req.user.username });
    }
    return res.status(401).json({ error: "Not authenticated" });
  });

  app.post("/api/register", authLimiter, (req, res, next) => {
    const { username, password } = req.body || {};
    const id = userStore.register(username, password);
    if (!id) return res.status(400).json({ error: "Invalid or taken username" });
    const user = { id, username: String(username).trim() };
    req.logIn(user, (err) => {
      if (err) return next(err);
      return res.status(201).json(user);
    });
  });

  app.post("/api/login", authLimiter, loginHandler);

  app.post("/api/logout", (req, res) => {
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
  io.engine.use(sessionMiddleware);

  const manager = new RoomManager(io, { ...opts, userStore });

  io.on("connection", (socket) => {
    manager.attach(socket);
  });

  function close() {
    return new Promise((resolve) => {
      io.close(() => {
        userStore.close();
        resolve();
      });
    });
  }

  return { app, httpServer, io, manager, userStore, close };
}

if (require.main === module) {
  const server = createServer();
  server.httpServer.listen(PORT, () => console.log("Listening: " + PORT));
}

module.exports = { createServer };
