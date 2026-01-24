const playwright = require("playwright");

function normalizeWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}

function extractPricesFromLine(line) {
  const matches = line.match(/£\d+(?:\.\d{2})?/g);
  return matches || [];
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

function looksLikeTicketLine(line) {
  const l = line.toLowerCase();
  return (
    l.includes("verified resale") ||
    l.includes("resale ticket") ||
    l.includes("ticket") ||
    l.includes("each") ||
    l.includes("per ticket")
  );
}

async function checkResale(url) {
  let browser;

  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForSelector("body", { timeout: 30000 });
    await page.waitForTimeout(3000);

    // Try accept cookies if present
    const acceptBtn = page.locator(
      "button:has-text('Accept'), button:has-text('Accept All'), button:has-text('I Accept')"
    );
    if (await acceptBtn.count()) {
      try {
        await acceptBtn.first().click({ timeout: 3000 });
        await page.waitForTimeout(1000);
      } catch {}
    }

    const bodyText = await page.locator("body").innerText();

    const hasResale =
      /Verified Resale Ticket/i.test(bodyText) || /\bResale\b/i.test(bodyText);

    if (!hasResale) return { resale: false, offers: [] };

    const lines = bodyText
      .split("\n")
      .map(normalizeWhitespace)
      .filter(Boolean);

    // Count ticket prices (heuristic)
    const priceCounts = new Map();

    for (const line of lines) {
      if (isFeeLine(line)) continue;
      if (!looksLikeTicketLine(line)) continue;

      const prices = extractPricesFromLine(line)
        .map(p => ({
          raw: p,
          num: parseFloat(p.replace("£", ""))
        }))
        .filter(p => !Number.isNaN(p.num))
        .filter(p => p.num >= 20); // drop tiny fees like £3.45

      for (const p of prices) {
        priceCounts.set(p.raw, (priceCounts.get(p.raw) || 0) + 1);
      }
    }

    // Fallback wider scan (still filtering fee lines + small prices)
    if (priceCounts.size === 0) {
      for (const line of lines) {
        if (isFeeLine(line)) continue;

        const prices = extractPricesFromLine(line)
          .map(p => ({
            raw: p,
            num: parseFloat(p.replace("£", ""))
          }))
          .filter(p => !Number.isNaN(p.num))
          .filter(p => p.num >= 20);

        for (const p of prices) {
          priceCounts.set(p.raw, (priceCounts.get(p.raw) || 0) + 1);
        }
      }
    }

    const offers = [...priceCounts.entries()]
      .map(([priceStr, count]) => ({
        priceStr,
        priceNum: parseFloat(priceStr.replace("£", "")),
        count
      }))
      .filter(o => !Number.isNaN(o.priceNum))
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
