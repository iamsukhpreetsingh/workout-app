// Gmail SMTP provider (STARTTLS on port 587) — the temporary transport.
// Requires a Gmail App Password (2-Step Verification enabled), NEVER the
// account password. Credentials come exclusively from environment
// variables and are never logged. Replace via EMAIL_PROVIDER env once a
// production provider is registered in provider.js.
const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } = process.env;
  if (!SMTP_USER || !SMTP_PASSWORD) {
    throw new Error('SMTP not configured: set SMTP_USER and SMTP_PASSWORD');
  }
  transporter = nodemailer.createTransport({
    host: SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true', // false = STARTTLS on 587
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
  });
  return transporter;
}

async function send({ to, subject, html, text }) {
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER;
  const info = await getTransporter().sendMail({
    from: `"Workout Tracker" <${from}>`,
    to,
    subject,
    html,
    text,
  });
  // never surface credentials or raw SMTP internals upward
  return { messageId: info.messageId };
}

module.exports = { send };
