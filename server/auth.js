"use strict";

const passport = require("passport");
const LocalStrategy = require("passport-local").Strategy;

// Wire Passport to the user store. Session serialisation keeps only the user id.
function configurePassport(userStore) {
  passport.use(
    new LocalStrategy((username, password, done) => {
      const user = userStore.verify(username, password);
      if (!user) return done(null, false, { message: "Invalid credentials" });
      return done(null, user);
    })
  );

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser((id, done) => {
    const user = userStore.findById(id);
    done(null, user || false);
  });

  return passport;
}

// Shared handler for the login form. Responds with JSON for fetch() callers.
function loginHandler(req, res, next) {
  passport.authenticate("local", (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.status(401).json({ error: info && info.message ? info.message : "Invalid credentials" });
    req.logIn(user, (loginErr) => {
      if (loginErr) return next(loginErr);
      return res.json({ id: user.id, username: user.username });
    });
  })(req, res, next);
}

module.exports = { configurePassport, loginHandler };
