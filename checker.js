const playwright = require("playwright");

// Toggle debug with env var:
// Railway: set DEBUG_TM=true
const DEBUG_TM = String(process.env.DEBUG_TM || "").toLowerCase() === "true";

function logDebug(...args) {
  if (DEBUG_TM) console.log("[TM DEBUG]", ...args);
}

function extractPrices(text) {
  const matches = text.match(/£\d+(?:\.\d{2})?/g);
  return matches || [];
}

function toNum(priceStr) {
  const n = parseFloat(String(priceStr).replace("£", ""));
  return Number.isNaN(n) ? null : n;
}

function normalizeWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
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

function detectBotBlockSignals(html, bodyText) {
  const h = (html || "").toLowerCase();
  const t = (bodyText || "").toLowerCase();

  // Ticketmaster / Akamai / Queue-it style signals
  const signals = [
    "access denied",
    "forbidden",
    "captcha",
    "are you a robot",
    "verify you are human",
    "pardon the interruption",
    "akamai",
    "incident id",
    "queue-it",
    "in queue",
    "you are now in line",
    "press and hold",
    "unusual traffic",
    "bot detection"
  ];

  return signals.some(s => h.includes(s) || t.includes(s));
}

async function checkResale(url) {
  let browser;

  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    // Use a context with real-ish browser signals
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      locale: "en-GB",
      timezoneId: "Europe/London",
      viewport: { width: 1366, height: 768 }
    });

    const page = await context.newPage();
    page.setDefaultTimeout(90000);

    // Optional: reduce noise + speed up (comment out if you want full load)
    // await page.route("**/*.{png,jpg,jpeg,webp,gif,svg}", route => route.abort());
    // await page.route("**/*.woff2", route => route.abort());

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForSelector("body", { timeout: 30000 });

    // Small settle time helps on Railway/container
    await page.waitForTimeout(2500);

    await acceptCookies(page);

    // ✅ Wait until resale/price content appears (best effort)
    await page
      .waitForFunction(() => {
        const t = document.body?.innerText || "";
        return (
          /Verified Resale Ticket/i.test(t) ||
          /£\d+(\.\d{2})?\s*(each|per)/i.test(t) ||
          /\bResale\b/i.test(t)
        );
      }, { timeout: 60000 })
      .catch(() => {});

    // force lazy content
    await scrollABit(page);

    const bodyText = await page.locator("body").innerText().catch(() => "");
    const html = await page.content().catch(() => "");

    if (DEBUG_TM) {
      const title = await page.title().catch(() => "");
      logDebug("URL:", page.url());
      logDebug("TITLE:", title);
      logDebug("HTML length:", html.length);
      logDebug("BODY length:", bodyText.length);
      logDebug("HTML preview:", normalizeWhitespace(html.slice(0, 400)));
      logDebug("BODY preview:", normalizeWhitespace(bodyText.slice(0, 400)));
    }

    // ✅ Detect bot-block pages
    if (detectBotBlockSignals(html, bodyText)) {
      console.log("🚫 Ticketmaster bot/queue protection likely detected on this run.");
      // Return a result that makes it obvious in logs
      return { resale: false, offers: [], blocked: true };
    }

    const hasResale =
      /Verified Resale Ticket/i.test(bodyText) || /\bResale\b/i.test(bodyText);

    if (!hasResale) return { resale: false, offers: [] };

    // ✅ DOM-first extraction: find price nodes and read surrounding card text
    const offersMap = new Map(); // priceStr -> count (ticket qty)

    const priceNodes = page.locator("text=/£\\d+(?:\\.\\d{2})?\\s*(each|per)/i");
    const pnCount = await priceNodes.count().catch(() => 0);
    const limit = Math.min(pnCount, 60);

    for (let i = 0; i < limit; i++) {
      const node = priceNodes.nth(i);
      const line = normalizeWhitespace(await node.innerText().catch(() => ""));
      if (!line) continue;

      const priceStr = extractPrices(line)[0];
      if (!priceStr) continue;

      const priceNum = toNum(priceStr);
      if (priceNum == null || priceNum < 20) continue; // ignore small fees

      // Try to get surrounding ticket card text
      let cardText = "";
      try {
        cardText = await node
          .locator("xpath=ancestor::*[self::li or self::div][1]")
          .innerText({ timeout: 2000 });
      } catch {
        cardText = line;
      }

      cardText = normalizeWhitespace(cardText);

      // Detect quantity like "2 tickets"
      let qty = 1;
      const m = cardText.match(/\b(\d+)\s*(ticket|tickets)\b/i);
      if (m) qty = parseInt(m[1], 10);

      offersMap.set(priceStr, (offersMap.get(priceStr) || 0) + qty);
    }

    // ✅ Fallback heuristic scan if DOM method found nothing
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

    return { resale: true, offers };
  } catch (err) {
    console.error("Error scraping page:", err);
    return { resale: false, offers: [] };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

module.exports = { checkResale };