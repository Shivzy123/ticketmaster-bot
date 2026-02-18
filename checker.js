const playwright = require("playwright");

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

async function checkResale(url) {
  let browser;

  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(90000);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForSelector("body", { timeout: 30000 });

    await acceptCookies(page);

    // ✅ Wait until ticket/price content appears
    await page.waitForFunction(() => {
      const t = document.body?.innerText || "";
      return /Verified Resale Ticket/i.test(t) || /£\d+(\.\d{2})?\s*(each|per)/i.test(t);
    }, { timeout: 60000 }).catch(() => {});

    // force lazy content
    await scrollABit(page);

    const bodyText = await page.locator("body").innerText().catch(() => "");
    const hasResale =
      /Verified Resale Ticket/i.test(bodyText) ||
      /\bResale\b/i.test(bodyText);

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

      // pull the first £xx.xx
      const priceStr = extractPrices(line)[0];
      if (!priceStr) continue;

      const priceNum = toNum(priceStr);
      if (priceNum == null || priceNum < 20) continue; // ignore fees like £3.45

      // Try to get surrounding ticket card text (parent container)
      let cardText = "";
      try {
        cardText = await node.locator("xpath=ancestor::*[self::li or self::div][1]").innerText({ timeout: 2000 });
      } catch {
        // fallback: nearby text
        cardText = line;
      }
      cardText = normalizeWhitespace(cardText);

      // Detect quantity like "2 tickets" in the card
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
      try { await browser.close(); } catch {}
    }
  }
}

module.exports = { checkResale };
