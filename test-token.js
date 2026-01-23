require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");

console.log("DISCORD_TOKEN:", process.env.DISCORD_TOKEN ? "SET" : "NOT SET");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", () => {
  console.log("Bot logged in!");
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error("Login failed:", err.code, err.message);
});
