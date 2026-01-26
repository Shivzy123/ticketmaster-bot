require("dotenv").config();

// ✅ Debug: check if environment variables are set
console.log("DISCORD_TOKEN:", process.env.DISCORD_TOKEN ? "SET" : "NOT SET");
console.log("CHANNEL_ID:", process.env.CHANNEL_ID ? "SET" : "NOT SET");

// ✅ Helps confirm Railway is running the latest deploy
console.log(
  "INDEX VERSION: offers-based checker + filters + hourly logs ✅ (NO COMMANDS)"
);
console.log("DEPLOY SHA:", process.env.RAILWAY_GIT_COMMIT_SHA || "unknown");

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { checkResale } = require("./checker");
const cron = require("node-cron");

// 🕰️ Channel for hourly check logs (TIME-CHECK)
const TIME_CHECK_CHANNEL_ID = "1465346769490809004";

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

// Event URLs mapped to dates
const EVENT_URLS = {
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-18-07-2026/event/2300638CCCE11DC5":
    "Sat 18th July",
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-19-07-2026/event/23006427C8FF0D82":
    "Sun 19th July",
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-22-07-2026/event/23006427F6C10F5B":
    "Wed 22nd July",
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-24-07-2026/event/23006427F78F0F67":
    "Fri 24th July",
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-25-07-2026/event/23006427F8750F70":
    "Sat 25th July",
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-28-07-2026/event/23006427FA0D0F8E":
    "Tue 28th July"
};

// ✅ Filters
const CHECK_COST = true;
const MAX_PRICE_GBP = 250;
const MIN_TICKETS = 2;

const BETWEEN_EVENTS_DELAY_MS = 2000;

let alertedEvents = {};
let isChecking = false;

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

function formatOffer(o) {
  return `${o.priceStr} — ${o.count} ticket${o.count === 1 ? "" : "s"}`;
}

function qualifyOffer(o) {
  if (!o) return false;
  if (o.count < MIN_TICKETS) return false;
  if (CHECK_COST && o.priceNum > MAX_PRICE_GBP) return false;
  return true;
}

// 🔍 Core checker (alerts go ONLY to ticket channel)
async function checkAllEvents(ticketChannel) {
  if (isChecking) return;
  isChecking = true;

  try {
    console.log("Checking all events for resale tickets...");

    for (const [url, date] of Object.entries(EVENT_URLS)) {
      try {
        const { resale, offers = [] } = await checkResale(url);
        const qualifying = offers.filter(qualifyOffer);

        if (resale && qualifying.length > 0) {
          if (!alertedEvents[url]) {
            const ts = ukTimestamp();
            const lines = qualifying.map(formatOffer).join(" | ");

            await ticketChannel.send(
              `🚨 **RESALE TICKETS DETECTED (MATCHED FILTERS)!** 🚨\n` +
                `Event Date: ${date}\n` +
                `Matches: ${lines}\n` +
                `Time Found (UK): ${ts}\n` +
                `${url}`
            );

            alertedEvents[url] = true;
            console.log(`Alert sent for ${date} at ${ts}`);
          }
        } else {
          alertedEvents[url] = false;
          console.log(
            resale
              ? `Resale found but no matches for ${date}`
              : `No resale tickets for ${date}`
          );
        }
      } catch (err) {
        console.error(`Error checking ${date}:`, err);
      }

      await new Promise(r => setTimeout(r, BETWEEN_EVENTS_DELAY_MS));
    }
  } finally {
    isChecking = false;
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // 🎟️ Ticket alerts channel
  const ticketChannel = await client.channels.fetch(process.env.CHANNEL_ID).catch(err => {
    console.error("Failed to fetch ticket channel", err);
    process.exit(1);
  });

  // 🕰️ Hourly TIME-CHECK channel
  const timeCheckChannel = await client.channels.fetch(TIME_CHECK_CHANNEL_ID).catch(err => {
    console.error("Failed to fetch TIME-CHECK channel", err);
    process.exit(1);
  });

  await ticketChannel.send("✅ Bot is online and monitoring Bruno Mars London 2026 events!");

  // Initial run
  await checkAllEvents(ticketChannel);

  // Every 5 minutes: background check
  cron.schedule("*/5 * * * *", async () => {
    await checkAllEvents(ticketChannel);
  });

  // Hourly: log check time ONLY in TIME-CHECK channel
  cron.schedule("0 * * * *", async () => {
    const label = ukHourLabel();
    await timeCheckChannel.send(`🕰️ **${label} check**`);
    await checkAllEvents(ticketChannel);
  });
});

client.login(process.env.DISCORD_TOKEN);
