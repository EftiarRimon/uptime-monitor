import express from "express";

const app = express();
const port = process.env.PORT ?? 3000;

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.listen(port, () => {
  console.log(`API listening on port ${port}`);
});