const { handleOrderApi } = require("../lib/order-api");

module.exports = async (req, res) => {
  return handleOrderApi(req, res, "/api/cron-prepare");
};
