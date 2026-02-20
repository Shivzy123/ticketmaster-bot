const playwright = require("playwright");
const fs = require("fs");
const path = require("path");

function extractPrices(text) {
  const matches = text.match(/£\d+(?:\.\d{2})?/g);
  return matches || [];
}

function toNum(priceStr) {
  const n = parseFloat(String(priceStr).replace("£", ""));
  return Number.isNaN(n) ? null : n;
}

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function isFeeLine(line) {
  const l = line.toLowerCase();
  return (
    l.includes("handling") ||
    l.includes("fee") ||
    l.includes("fees") ||
    l.includes("delivery") ||
    l.includes("service charge") ||
    l.includes("order") ||
    l.includes("facility") ||
    l.includes("transaction")
  );
}

function cleanUrl(url) {
  // strip queue tokens / referrers / tracking — these often expire & push you into queue
  return String(url || "").split("?")[0];
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_${pad(d.getUTCHours())}-${pad(
    d.getUTCMinutes()
  )}-${pad(d.getUTCSeconds())}`;
}

function detectProtection(bodyText, finalUrl) {
  const t = (bodyText || "").toLowerCase();
  const u = (finalUrl || "").toLowerCase();

  const signals = [
    { key: "queue-it", hit: u.includes("queue") || u.includes("queue-it") || u.includes("queueit") || t.includes("queue-it") },
    { key: "access denied", hit: t.includes("access denied") || t.includes("forbidden") || t.includes("error 403") },
    { key: "pardon interruption", hit: t.includes("pardon our interruption") || t.includes("unusual traffic") },
    { key: "verify human", hit: t.includes("verify you are human") || t.includes("human verification") || t.includes("are you a robot") },
    { key: "captcha", hit: t.includes("captcha") || t.includes("recaptcha") },
    { key: "blocked", hit: t.includes("you have been blocked") || t.includes("bot detection") || t.includes("automated requests") },
  ];

  const matched = signals.filter(s => s.hit).map(s => s.key);
  if (matched.length) {
    return { blocked: true, reason: matched.join(", ") };
  }
  return { blocked: false, reason: "" };
}

async function acceptCookies(page) {
  const acceptBtn = page.locator(
    "button:has-text('Accept'), button:has-text('Accept All'), button:has-text('I Accept')"
  );
  if (await acceptBtn.count()) {
    try {
      await acceptBtn.first().click({ timeout: 3000 });
      await page.waitForTimeout(800);
    } catch {}
  }
}

async function scrollABit(page) {
  try {
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(800);
    }
    await page.mouse.wheel(0, -1200);
    await page.waitForTimeout(800);
  } catch {}
}

async function saveDebugArtifacts(page, label) {
  try {
    const dir = process.env.DEBUG_DUMP_DIR || path.join(process.cwd(), "debug_dumps");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const stamp = nowStamp();
    const safe = label.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 80);

    const pngPath = path.join(dir, `${stamp}_${safe}.png`);
    const htmlPath = path.join(dir, `${stamp}_${safe}.html`);
    const urlPath = path.join(dir, `${stamp}_${safe}.url.txt`);

    await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => "");
    fs.writeFileSync(htmlPath, html || "", "utf8");
    fs.writeFileSync(urlPath, String(page.url() || ""), "utf8");

    console.log(`🧾 Saved debug artifacts: ${pngPath} / ${htmlPath}`);
  } catch (e) {
    console.log("⚠️ Failed to save debug artifacts:", e?.message || e);
  }
}

async function checkResale(url) {
  let browser;
  const targetUrl = cleanUrl(url);

  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const context = await browser.newContext({
      locale: "en-GB",
      timezoneId: "Europe/London",
      viewport: { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    });

    const page = await context.newPage();
    page.setDefaultTimeout(90000);

    // small stealth-ish patch (won't magically fix queue, but can help a bit)
    await page.addInitScript(() => {
      try {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      } catch {}
    });

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForSelector("body", { timeout: 30000 });

    await acceptCookies(page);

    // wait for “some” meaningful content
    await page
      .waitForFunction(() => {
        const t = document.body?.innerText || "";
        return (
          t.length > 500 &&
          (/Verified Resale Ticket/i.test(t) ||
            /\bResale\b/i.test(t) ||
            /£\d+(\.\d{2})?/i.test(t))
        );
      }, { timeout: 45000 })
      .catch(() => {});

    await scrollABit(page);

    const finalUrl = page.url();
    const bodyText = await page.locator("body").innerText().catch(() => "");

    // detect queue/bot/blocked pages
    const prot = detectProtection(bodyText, finalUrl);
    if (prot.blocked) {
      console.log("🚫 Ticketmaster bot/queue protection likely detected on this run.");
      console.log(`🚫 Reason: ${prot.reason}`);
      console.log(`🚫 Final URL: ${finalUrl}`);

      if (process.env.SAVE_BLOCKED_DUMPS === "true") {
        await saveDebugArtifacts(page, `blocked_${prot.reason}`);
      }

      return { resale: false, offers: [], blocked: true, reason: prot.reason, finalUrl };
    }

    const hasResale =
      /Verified Resale Ticket/i.test(bodyText) || /\bResale\b/i.test(bodyText);

    if (!hasResale) {
      return { resale: false, offers: [], blocked: false, finalUrl };
    }

    // DOM-first: find price nodes
    const offersMap = new Map(); // priceStr -> count (ticket qty)
    const priceNodes = page.locator("text=/£\\d+(?:\\.\\d{2})?/i");

    const pnCount = await priceNodes.count().catch(() => 0);
    const limit = Math.min(pnCount, 120);

    for (let i = 0; i < limit; i++) {
      const node = priceNodes.nth(i);
      const line = normalizeWhitespace(await node.innerText().catch(() => ""));
      if (!line) continue;

      const priceStr = extractPrices(line)[0];
      if (!priceStr) continue;

      const priceNum = toNum(priceStr);
      if (priceNum == null || priceNum < 20) continue;

      let cardText = "";
      try {
        // broaden ancestor search a bit
        cardText = await node.locator("xpath=ancestor::*[self::li or self::article or self::section or self::div][1]")
          .innerText({ timeout: 2000 });
      } catch {
        cardText = line;
      }
      cardText = normalizeWhitespace(cardText);

      // quantity in card
      let qty = 1;
      const m = cardText.match(/\b(\d+)\s*(ticket|tickets)\b/i);
      if (m) qty = parseInt(m[1], 10);

      offersMap.set(priceStr, (offersMap.get(priceStr) || 0) + (Number.isFinite(qty) ? qty : 1));
    }

    // fallback: text scan
    if (offersMap.size === 0) {
      const lines = bodyText
        .split("\n")
        .map(normalizeWhitespace)
        .filter(Boolean);

      for (const line of lines) {
        if (isFeeLine(line)) continue;

        const prices = extractPrices(line)
          .map(p => ({ raw: p, num: toNum(p) }))
          .filter(p => p.num != null && p.num >= 20);

        for (const p of prices) {
          offersMap.set(p.raw, (offersMap.get(p.raw) || 0) + 1);
        }
      }
    }

    const offers = [...offersMap.entries()]
      .map(([priceStr, count]) => ({
        priceStr,
        priceNum: toNum(priceStr),
        count
      }))
      .filter(o => o.priceNum != null)
      .sort((a, b) => a.priceNum - b.priceNum);

    return { resale: true, offers, blocked: false, finalUrl };
  } catch (err) {
    console.error("Error scraping page:", err);
    return { resale: false, offers: [], blocked: false };
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

module.exports = { checkResale, cleanUrl };