const { handleOrderApi, parseBody } = require("../lib/order-api");

module.exports = async (req, res) => {
  req.body = parseBody(req);
  return handleOrderApi(req, res, "/api/orders");
};
