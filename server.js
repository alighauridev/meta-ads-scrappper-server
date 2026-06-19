/**
 * Meta Ads Library Scraper — HTTP API
 * --------------------------------------------------------------------------
 * Wraps scrape-ads.js as a web service so Manus (or anything else) can call it
 * over HTTPS instead of scraping the Ads Library itself.
 *
 * Register this in Manus under: My plugins -> Create -> Custom API
 * (paste your hosted URL + the API key below).
 *
 * Because a full scrape takes minutes and Manus times out long requests, the
 * main flow is ASYNC: start a job, then poll for results.
 *
 *   POST /scrape/start   { term, max?, enrichPage?, classify? }  -> { jobId }
 *   GET  /scrape/status/:jobId                                   -> { status, leadCount, leads? }
 *   GET  /scrape?term=...&max=...                                -> synchronous (small batches only)
 *   GET  /health                                                 -> { ok: true }
 *
 * Auth: set API_KEY env var; callers must send  Authorization: Bearer <API_KEY>
 *
 * Run:  npm install  &&  node server.js          (listens on PORT, default 8080)
 */

import express from "express";
import { spawn } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOBS_DIR = path.join(__dirname, "jobs");
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || ""; // empty = no auth (set one in production)

const app = express();
app.use(express.json());

// in-memory job registry (fine for a single instance; use a DB if you scale out)
const jobs = new Map(); // jobId -> { status, leadCount, error, outPath, startedAt }

// ---- simple bearer-token auth -------------------------------------------
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (!API_KEY) return next(); // auth disabled if no key configured
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${API_KEY}`) return next();
  return res.status(401).json({ error: "unauthorized" });
});

// ---- helper: run the scraper CLI as a child process ---------------------
// `tag` is a short label (e.g. job id prefix) prepended to every log line so
// concurrent jobs are distinguishable in the server console.
function runScrape({ term, max, country, enrichPage, classify }, outPath, tag = "") {
  const args = [
    "scrape-ads.js",
    "--terms", term,
    "--max", String(max || 50),
    "--country", country || "US",
    "--idle", "25",
    "--out", outPath,
  ];
  if (enrichPage) args.push("--enrich-page");
  if (classify) args.push("--classify");

  const prefix = tag ? `[${tag}] ` : "";
  console.log(`${prefix}scrape start: term="${term}" country=${country || "US"} max=${max || 50} enrichPage=${!!enrichPage} classify=${!!classify}`);

  const child = spawn("node", args, { cwd: __dirname });
  let stderr = "";

  // Stream child output to the server console live, line by line, tagged.
  const relay = (stream, sink) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        sink(prefix + buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    stream.on("end", () => { if (buf.trim()) sink(prefix + buf); });
  };
  relay(child.stdout, (line) => console.log(line));
  relay(child.stderr, (line) => { stderr += line + "\n"; console.error(line); });

  return new Promise((resolve, reject) => {
    child.on("close", (code) => {
      if (code === 0) {
        console.log(`${prefix}scrape done`);
        resolve();
      } else {
        reject(new Error(`scraper exited ${code}: ${stderr.slice(-500)}`));
      }
    });
    child.on("error", reject);
  });
}

// ---- POST /scrape/start  (async) ----------------------------------------
app.post("/scrape/start", async (req, res) => {
  const { term, max = 50, country = "US", enrichPage = false, classify = false } = req.body || {};
  if (!term) return res.status(400).json({ error: "missing 'term'" });

  const jobId = randomUUID();
  const outPath = path.join(JOBS_DIR, `${jobId}.json`);
  await mkdir(JOBS_DIR, { recursive: true });
  jobs.set(jobId, {
    status: "running", leadCount: 0, outPath, startedAt: Date.now(), finishedAt: null,
    term, max, country, enrichPage: !!enrichPage, classify: !!classify,
  });

  // kick off in the background; respond immediately
  runScrape({ term, max, country, enrichPage, classify }, outPath, jobId.slice(0, 8))
    .then(async () => {
      let leads = [];
      try { leads = JSON.parse(await readFile(outPath, "utf8")); } catch {}
      jobs.set(jobId, { ...jobs.get(jobId), status: "done", leadCount: leads.length, finishedAt: Date.now() });
      console.log(`[${jobId.slice(0, 8)}] job done: ${leads.length} leads`);
    })
    .catch((err) => {
      jobs.set(jobId, { ...jobs.get(jobId), status: "error", error: err.message, finishedAt: Date.now() });
      console.error(`[${jobId.slice(0, 8)}] job error: ${err.message}`);
    });

  res.json({ jobId, status: "running" });
});

// ---- GET /jobs  (monitoring: list all jobs, newest first) ---------------
app.get("/jobs", (_req, res) => {
  const now = Date.now();
  const list = [...jobs.entries()]
    .map(([jobId, j]) => ({
      jobId,
      status: j.status,
      term: j.term ?? null,
      max: j.max ?? null,
      country: j.country ?? null,
      leadCount: j.leadCount ?? 0,
      error: j.error ?? null,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt ?? null,
      elapsedSec: Math.round(((j.finishedAt ?? now) - j.startedAt) / 1000),
    }))
    .sort((a, b) => b.startedAt - a.startedAt);
  res.json({
    running: list.filter((j) => j.status === "running").length,
    done: list.filter((j) => j.status === "done").length,
    error: list.filter((j) => j.status === "error").length,
    total: list.length,
    jobs: list,
  });
});

// ---- GET /scrape/status/:jobId ------------------------------------------
app.get("/scrape/status/:jobId", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "unknown jobId" });
  if (job.status === "running") {
    return res.json({ status: "running", elapsedSec: Math.round((Date.now() - job.startedAt) / 1000) });
  }
  if (job.status === "error") {
    return res.status(500).json({ status: "error", error: job.error });
  }
  // done -> return the leads
  let leads = [];
  try { leads = JSON.parse(await readFile(job.outPath, "utf8")); } catch {}
  res.json({ status: "done", leadCount: leads.length, leads });
});

// ---- GET /scrape  (synchronous; small batches only) ---------------------
app.get("/scrape", async (req, res) => {
  const term = req.query.term;
  const max = parseInt(req.query.max, 10) || 25;
  const country = req.query.country || "US";
  const enrichPage = req.query.enrichPage === "true";
  const classify = req.query.classify === "true";
  if (!term) return res.status(400).json({ error: "missing 'term'" });
  if (max > 50) return res.status(400).json({ error: "use POST /scrape/start for max > 50" });

  const outPath = path.join(JOBS_DIR, `sync-${randomUUID()}.json`);
  await mkdir(JOBS_DIR, { recursive: true });
  try {
    await runScrape({ term, max, country, enrichPage, classify }, outPath, "sync");
    const leads = JSON.parse(await readFile(outPath, "utf8"));
    res.json({ leadCount: leads.length, leads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Ads scraper API listening on :${PORT}` + (API_KEY ? " (auth on)" : " (no auth — set API_KEY)"));
});
