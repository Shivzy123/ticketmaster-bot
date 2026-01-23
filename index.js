require("dotenv").config();
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { checkResale } = require("./checker");
const cron = require("node-cron");

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});

// Event URLs mapped to dates
const EVENT_URLS = {
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-18-07-2026/event/2300638CCCE11DC5": "Sat 18th July",
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-19-07-2026/event/23006427C8FF0D82": "Sun 19th July",
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-22-07-2026/event/23006427F6C10F5B": "Wed 22nd July",
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-24-07-2026/event/23006427F78F0F67": "Fri 24th July",
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-25-07-2026/event/23006427F8750F70": "Sat 25th July",
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-28-07-2026/event/23006427FA0D0F8E": "Tue 28th July"
};

let alertedEvents = {};

// Function to check all events
async function checkAllEvents(channel) {
  console.log("Checking all events for resale tickets...");
  for (const [url, date] of Object.entries(EVENT_URLS)) {
    try {
      const { resale, price } = await checkResale(url);

      if (resale && !alertedEvents[url]) {
        await channel.send(
          `🚨 **RESALE TICKETS DETECTED!** 🚨\nEvent Date: ${date}\nPrice: ${price}\n${url}`
        );
        alertedEvents[url] = true;
        console.log(`Alert sent for ${date}`);
      }

      if (!resale) {
        alertedEvents[url] = false;
        console.log(`No resale tickets for ${date}`);
      }
    } catch (err) {
      console.error(`Error checking ${date}:`, err);
    }
  }
}

// Bot ready
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const channel = await client.channels.fetch(process.env.CHANNEL_ID).catch(err => {
    console.error("Failed to fetch Discord channel:", err);
    process.exit(1);
  });

  channel.send("✅ Bot is online and monitoring all Bruno Mars London 2026 events!");

  // Immediate check on startup
  await checkAllEvents(channel);

  // Cron to check every 1 minute (change to */5 * * * * for production)
  cron.schedule("*/1 * * * *", async () => {
    await checkAllEvents(channel);
  });
});

client.login(process.env.DISCORD_TOKEN);
