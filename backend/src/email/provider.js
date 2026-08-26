// Email service — thin provider abstraction. Business code calls
// sendEmail({ to, subject, html, text }) and never knows which transport
// is configured. Today that's Gmail SMTP (smtpProvider.js); swapping in
// Resend/SendGrid/SES later means adding one provider file and registering
// it here — no changes anywhere else.
//
// Tests can inject a fake via setEmailProviderForTests().
const smtpProvider = require('./smtpProvider');

const PROVIDERS = {
  smtp: smtpProvider,
};

let override = null;

function activeProvider() {
  if (override) return override;
  const name = process.env.EMAIL_PROVIDER || 'smtp';
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown EMAIL_PROVIDER: ${name}`);
  return p;
}

// Returns the provider result ({ messageId, ... }) — callers decide what a
// failure means; this layer only normalizes transport errors.
async function sendEmail({ to, subject, html, text }) {
  return activeProvider().send({ to, subject, html, text });
}

// Test-only dependency injection — never used in production paths.
function setEmailProviderForTests(fake) {
  override = fake;
}

module.exports = { sendEmail, setEmailProviderForTests };
