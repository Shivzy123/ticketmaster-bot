const playwright = require("playwright");

function normalizeWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}

function extractPricesFromLine(line) {
  const matches = line.match(/£\d+(?:\.\d{2})?/g);
  return matches || [];
}

// Filters out obvious non-ticket prices (fees, handling, delivery, etc.)
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

// Heuristic: ticket listing lines often contain these words
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

    // Try to accept cookies if a banner appears (safe if not present)
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
      /Verified Resale Ticket/i.test(bodyText) ||
      /\bResale\b/i.test(bodyText);

    if (!hasResale) return { resale: false, price: null };

    // Split into lines and analyze
    const lines = bodyText
      .split("\n")
      .map(normalizeWhitespace)
      .filter(Boolean);

    // Count ticket prices
    const priceCounts = new Map();

    for (const line of lines) {
      if (isFeeLine(line)) continue;
      if (!looksLikeTicketLine(line)) continue;

      // Only keep sensible ticket prices (avoid small fee amounts)
      const prices = extractPricesFromLine(line)
        .map(p => ({ raw: p, num: parseFloat(p.replace("£", "")) }))
        .filter(p => !Number.isNaN(p.num))
        .filter(p => p.num >= 20); // <— drops £3.45 etc.

      for (const p of prices) {
        priceCounts.set(p.raw, (priceCounts.get(p.raw) || 0) + 1);
      }
    }

    // Fallback: if we failed to find any prices with the “ticket line” heuristic,
    // do a wider extraction but still filter fees + small numbers.
    if (priceCounts.size === 0) {
      for (const line of lines) {
        if (isFeeLine(line)) continue;

        const prices = extractPricesFromLine(line)
          .map(p => ({ raw: p, num: parseFloat(p.replace("£", "")) }))
          .filter(p => !Number.isNaN(p.num))
          .filter(p => p.num >= 20);

        for (const p of prices) {
          priceCounts.set(p.raw, (priceCounts.get(p.raw) || 0) + 1);
        }
      }
    }

    if (priceCounts.size === 0) {
      return { resale: true, price: "Resale detected (price not parsed)" };
    }

    // Format: £241.01 — 2 tickets | £563.22 — 1 ticket
    const formatted = [...priceCounts.entries()]
      .sort((a, b) => {
        const na = parseFloat(a[0].replace("£", ""));
        const nb = parseFloat(b[0].replace("£", ""));
        return na - nb;
      })
      .map(([p, count]) => `${p} — ${count} ticket${count === 1 ? "" : "s"}`)
      .join(" | ");

    return { resale: true, price: formatted };
  } catch (err) {
    console.error("Error scraping page:", err);
    return { resale: false, price: null };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

module.exports = { checkResale };
