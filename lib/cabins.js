const OWNER_CABIN_NUMBER = 0;
const MIN_CABIN_NUMBER = 0;
const MAX_CABIN_NUMBER = 12;
const MIN_GUEST_CABIN_NUMBER = 1;

function isValidCabinNumber(value) {
  const number = Number(value);
  return (
    Number.isFinite(number) &&
    number >= MIN_CABIN_NUMBER &&
    number <= MAX_CABIN_NUMBER
  );
}

function listAdminCabinNumbers() {
  return Array.from(
    { length: MAX_CABIN_NUMBER - MIN_CABIN_NUMBER + 1 },
    (_, index) => MIN_CABIN_NUMBER + index
  );
}

module.exports = {
  OWNER_CABIN_NUMBER,
  MIN_CABIN_NUMBER,
  MAX_CABIN_NUMBER,
  MIN_GUEST_CABIN_NUMBER,
  isValidCabinNumber,
  listAdminCabinNumbers,
};
