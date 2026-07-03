function normalizeCartLine(line) {
  const quantity = Math.max(0, Math.floor(Number(line?.quantity) || 0));
  const price = Number(line?.price) || 0;
  const settledQuantity = Math.min(
    quantity,
    Math.max(0, Math.floor(Number(line?.settledQuantity) || 0))
  );

  const normalized = {
    id: String(line?.id || ""),
    name: String(line?.name || "Страва"),
    price,
    quantity,
  };

  if (settledQuantity > 0) {
    normalized.settledQuantity = settledQuantity;
  }

  return normalized;
}

function normalizeCart(cart) {
  if (!Array.isArray(cart)) {
    return [];
  }

  return cart.map(normalizeCartLine).filter((line) => line.quantity > 0);
}

function getLineOpenQuantity(line) {
  const quantity = Math.max(0, Number(line?.quantity) || 0);
  const settled = Math.min(
    quantity,
    Math.max(0, Number(line?.settledQuantity) || 0)
  );
  return Math.max(0, quantity - settled);
}

function getLineOpenTotal(line) {
  return getLineOpenQuantity(line) * (Number(line?.price) || 0);
}

function getOrderOpenTotal(cart) {
  return normalizeCart(cart).reduce(
    (sum, line) => sum + getLineOpenTotal(line),
    0
  );
}

function getOrderFullTotal(cart) {
  return normalizeCart(cart).reduce(
    (sum, line) => sum + line.quantity * line.price,
    0
  );
}

function isOrderFullySettled(cart) {
  const lines = normalizeCart(cart);
  if (lines.length === 0) {
    return true;
  }

  return lines.every((line) => getLineOpenQuantity(line) === 0);
}

function getOrderBillAmount(order) {
  if (!order || order.status === "cancelled") {
    return 0;
  }

  return getOrderOpenTotal(order.cart);
}

function sumOrdersOpenAmount(orders, statuses) {
  return (orders || [])
    .filter((order) => statuses.includes(order.status))
    .reduce((sum, order) => sum + getOrderBillAmount(order), 0);
}

function mergeCartEdits(existingCart, nextCart) {
  const existing = normalizeCart(existingCart);

  return normalizeCart(nextCart).map((line, index) => {
    const previous = existing[index];
    let settledQuantity = 0;

    if (previous && previous.id === line.id && previous.name === line.name) {
      settledQuantity = Math.min(line.quantity, previous.settledQuantity || 0);
    }

    if (settledQuantity > 0) {
      return { ...line, settledQuantity };
    }

    return line;
  });
}

function settleCartLine(cart, lineIndex, quantity = 1) {
  const lines = normalizeCart(cart);

  if (lineIndex < 0 || lineIndex >= lines.length) {
    throw new Error("Невірна позиція в замовленні");
  }

  const line = { ...lines[lineIndex] };
  const openQuantity = getLineOpenQuantity(line);
  const settleQuantity = Math.min(
    openQuantity,
    Math.max(1, Math.floor(Number(quantity) || 1))
  );

  if (settleQuantity <= 0) {
    throw new Error("Цю позицію вже розраховано");
  }

  line.settledQuantity = (line.settledQuantity || 0) + settleQuantity;
  lines[lineIndex] = line;

  return lines;
}

module.exports = {
  normalizeCart,
  normalizeCartLine,
  getLineOpenQuantity,
  getLineOpenTotal,
  getOrderOpenTotal,
  getOrderFullTotal,
  isOrderFullySettled,
  getOrderBillAmount,
  sumOrdersOpenAmount,
  mergeCartEdits,
  settleCartLine,
};
