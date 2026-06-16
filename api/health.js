const API_VERSION = "2026-06-16-v3";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "https://calendarhouses.github.io");
  res.setHeader("X-Azhunebi-Version", API_VERSION);
  return res.status(200).json({
    ok: true,
    service: "azhunebi-bot",
    version: API_VERSION,
  });
};
