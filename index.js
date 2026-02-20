require("dotenv").config();

console.log("DISCORD_TOKEN:", process.env.DISCORD_TOKEN ? "SET" : "NOT SET");
console.log("CHANNEL_ID:", process.env.CHANNEL_ID ? "SET" : "NOT SET");

console.log(
  "INDEX VERSION: resilient Ticketmaster checker (protection-detect + dumps + sane retries + jitter) ✅"
);
console.log("DEPLOY SHA:", process.env.RAILWAY_GIT_COMMIT_SHA || "unknown");

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { checkResale, cleanUrl } = require("./checker");
const cron = require("node-cron");

const TIME_CHECK_CHANNEL_ID = "1465346769490809004";

// If you want screenshots/HTML when blocked:
process.env.SAVE_BLOCKED_DUMPS = process.env.SAVE_BLOCKED_DUMPS || "true";

// Reduce blocks:
const CHECK_CRON_EVERY_MINUTES = 15; // was 5 — slower helps a lot on Railway
const BETWEEN_EVENTS_DELAY_MS = 2500;
const JITTER_MS = 2500;

const DEBUG_RESULTS = true;

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});

const EVENTS = {
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-18-07-2026/event/2300638CCCE11DC5": {
    artist: "Bruno Mars",
    date: "Sat 18th July",
    location: "London",
    maxPrice: 2000,
    enabledUntil: "2026-07-18",
    minTickets: 1
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-19-07-2026/event/23006427C8FF0D82": {
    artist: "Bruno Mars",
    date: "Sun 19th July",
    location: "London",
    maxPrice: 2000,
    enabledUntil: "2026-07-19",
    minTickets: 1
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-22-07-2026/event/23006427F6C10F5B": {
    artist: "Bruno Mars",
    date: "Wed 22nd July",
    location: "London",
    maxPrice: 2000,
    enabledUntil: "2026-07-22",
    minTickets: 1
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-24-07-2026/event/23006427F78F0F67": {
    artist: "Bruno Mars",
    date: "Fri 24th July",
    location: "London",
    maxPrice: 2000,
    enabledUntil: "2026-07-24",
    minTickets: 1
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-25-07-2026/event/23006427F8750F70": {
    artist: "Bruno Mars",
    date: "Sat 25th July",
    location: "London",
    maxPrice: 2000,
    enabledUntil: "2026-07-25",
    minTickets: 1
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-28-07-2026/event/23006427FA0D0F8E": {
    artist: "Bruno Mars",
    date: "Tue 28th July",
    location: "London",
    maxPrice: 2000,
    enabledUntil: "2026-07-28",
    minTickets: 1
  }
};

let alertedEvents = {}; // key -> boolean
let isChecking = false;

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

// keep Railway alive even if cron pauses
setInterval(() => {}, 60 * 1000);

function ukTimestamp() {
  return new Date().toLocaleString("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function ukHourLabel() {
  return new Date().toLocaleString("en-GB", {
    timeZone: "Europe/London",
    hour: "numeric",
    hour12: true
  });
}

function ukDateYYYYMMDD() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const year = parts.find(p => p.type === "year").value;
  const month = parts.find(p => p.type === "month").value;
  const day = parts.find(p => p.type === "day").value;
  return `${year}-${month}-${day}`;
}

function isEventEnabled(info) {
  if (!info) return false;
  const until = String(info.enabledUntil || "").trim();
  if (!until) return true;
  const today = ukDateYYYYMMDD();
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(until);
  if (!valid) return true;
  return today <= until;
}

function qualifiesByPrice(o, maxPrice) {
  if (!o) return false;
  if (typeof o.priceNum !== "number" || Number.isNaN(o.priceNum)) return false;
  return o.priceNum <= maxPrice;
}

function formatOfferLine(o) {
  // show as "£488.60 — 4 tickets"
  return `${o.priceStr} — ${o.count} ticket${o.count === 1 ? "" : "s"}`;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithBackoff(url, label) {
  // Attempt 1
  let r = await checkResale(url);
  if (r?.blocked) return { ...r, attempt: 1 };

  // If not blocked but empty, try one more time after short delay
  if (!r?.resale || !Array.isArray(r?.offers) || r.offers.length === 0) {
    console.log(`⚠️ Possible false-negative for ${label} — retry in 7000ms...`);
    await sleep(7000);
    r = await checkResale(url);
    if (r?.blocked) return { ...r, attempt: 2 };
  }

  return { ...r, attempt: 2 };
}

async function checkAllEvents(ticketChannel) {
  if (isChecking) return;
  isChecking = true;

  try {
    console.log("Checking all events for resale tickets...");

    for (const [rawUrl, info] of Object.entries(EVENTS)) {
      const url = cleanUrl(rawUrl);
      const key = url; // use clean key so query changes don’t break alert state

      const { artist, date, location, maxPrice, minTickets, enabledUntil } = info;

      if (!isEventEnabled(info)) {
        console.log(`⏭️ Skipping (expired): ${artist} (${date}) — enabledUntil=${enabledUntil}`);
        continue;
      }

      const minTicketsForEvent = typeof minTickets === "number" ? minTickets : 1;

      try {
        const res = await fetchWithBackoff(url, `${artist} (${date})`);

        if (res.blocked) {
          console.log(`🚫 Blocked for ${artist} (${date}) — ${res.reason || "unknown"}`);
          // Don't flip alerted state; just skip
          continue;
        }

        const resale = !!res.resale;
        const offers = Array.isArray(res.offers) ? res.offers : [];

        const qualifying = offers.filter(o => qualifiesByPrice(o, maxPrice));
        const totalTickets = qualifying.reduce((sum, o) => sum + (typeof o.count === "number" ? o.count : 0), 0);

        if (DEBUG_RESULTS) {
          console.log(
            `[DEBUG] ${artist} (${date}) attempt=${res.attempt} resale=${resale} offers=${offers.length} qualifying=${qualifying.length} totalTickets=${totalTickets} alerted=${!!alertedEvents[key]} finalUrl=${res.finalUrl || ""}`
          );
        }

        if (resale && qualifying.length > 0 && totalTickets >= minTicketsForEvent) {
          if (!alertedEvents[key]) {
            const ts = ukTimestamp();
            const lines = qualifying.map(formatOfferLine).join(" | ");

            await ticketChannel.send(
              `🚨 **RESALE TICKETS DETECTED (MATCHED FILTERS)!** 🚨\n` +
              `Artist: ${artist}\n` +
              `Location: ${location}\n` +
              `Event Date: ${date}\n` +
              `Max Price: £${maxPrice}\n` +
              `Matches: ${lines}\n` +
              `Time Found (UK): ${ts}\n` +
              `${url}`
            );

            alertedEvents[key] = true;
            console.log(`Alert sent for ${artist} (${date})`);
          }
        } else {
          alertedEvents[key] = false;
          console.log(
            resale
              ? `Resale found but no matches for ${artist} (${date}) (qualifying tickets: ${totalTickets}, need ${minTicketsForEvent})`
              : `No resale tickets for ${artist} (${date})`
          );
        }
      } catch (err) {
        console.error(`Error checking ${artist} (${date}):`, err);
      }

      await sleep(BETWEEN_EVENTS_DELAY_MS + Math.floor(Math.random() * JITTER_MS));
    }
  } finally {
    isChecking = false;
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const ticketChannel = await client.channels.fetch(process.env.CHANNEL_ID).catch(err => {
    console.error("Failed to fetch ticket channel. Check CHANNEL_ID.", err);
    process.exit(1);
  });

  const timeCheckChannel = await client.channels.fetch(TIME_CHECK_CHANNEL_ID).catch(err => {
    console.error("Failed to fetch time-check channel. Check TIME_CHECK_CHANNEL_ID.", err);
    process.exit(1);
  });

  await ticketChannel.send("✅ Bot is online and monitoring Ticketmaster resale events!");

  await checkAllEvents(ticketChannel);

  // Every N minutes (timezone not needed for minute-based)
  cron.schedule(`*/${CHECK_CRON_EVERY_MINUTES} * * * *`, async () => {
    await checkAllEvents(ticketChannel);
  });

  // Hourly log (timezone matters)
  cron.schedule(
    "0 * * * *",
    async () => {
      const label = ukHourLabel();
      await timeCheckChannel.send(`🕰️ **${label} check**`);
      await checkAllEvents(ticketChannel);
    },
    { timezone: "Europe/London" }
  );
});

client.login(process.env.DISCORD_TOKEN);