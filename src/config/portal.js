function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

module.exports = {
  sessionMinutes: () => positiveNumber(process.env.PORTAL_SESSION_INACTIVITY_MINUTES, 60),
  paymentIntervalMinutes: () => positiveNumber(process.env.PAYMENT_SYNC_INTERVAL_MINUTES, 60),
  paymentEnabled: () => process.env.PAYMENT_ACCESS_CONTROL_ENABLED === 'true',
};
