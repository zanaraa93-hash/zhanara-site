const fs = require("fs");
const path = require("path");
const express = require("express");

function registerStatic(app, config) {
  // Only these folders and pages are public; everything else in the project root
  // (data/, server/, node_modules/, .env, src/, stray files) must never be served.
  const staticOptions = { dotfiles: "deny", index: false, fallthrough: true };
  app.use(
    "/assets",
    express.static(path.join(config.distDir, "assets"), { ...staticOptions, immutable: true, maxAge: "1y" })
  );
  app.use("/img", express.static(config.imgDir, staticOptions));
  app.use("/uploads", express.static(config.uploadsDir, staticOptions));

  function sendBuiltPage(res, next, file, transform = (html) => html) {
    fs.readFile(path.join(config.distDir, file), "utf8", (err, html) => {
      if (err?.code === "ENOENT") {
        return res
          .status(503)
          .type("text/plain; charset=utf-8")
          .send("Фронтенд не собран. Выполните: npm run build");
      }
      if (err) return next(err);
      res.set("Cache-Control", "no-store");
      res.type("html").send(transform(html));
    });
  }

  // Messenger link previews need absolute image URLs. Prefer SITE_URL: the Host
  // header is client-controlled.
  app.get(["/", "/index.html"], (req, res, next) => {
    const origin = config.siteUrl || `${req.protocol}://${req.get("host")}`;
    const safeOrigin = origin.replace(/[^\w.:/-]/g, "");
    sendBuiltPage(res, next, "index.html", (html) => html.replaceAll("__SITE_URL__", safeOrigin));
  });

  app.get(["/admin", "/admin.html"], (_req, res, next) => {
    sendBuiltPage(res, next, "admin.html");
  });
}

function frontendBuilt(config) {
  return fs.existsSync(path.join(config.distDir, "index.html"));
}

module.exports = { registerStatic, frontendBuilt };
