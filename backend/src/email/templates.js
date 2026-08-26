// Password-reset email template. Pure functions — no transport knowledge.

function buildResetUrl(rawToken) {
  // Deep link into the mobile app; falls back to FRONTEND_URL for a future
  // web client when no app scheme is configured.
  const scheme = process.env.APP_SCHEME;
  if (scheme) return `${scheme}://reset-password?token=${encodeURIComponent(rawToken)}`;
  const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(rawToken)}`;
}

function passwordResetEmail({ resetUrl, expiresInMinutes }) {
  const subject = 'Reset your Workout Tracker password';
  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
    <h1 style="margin:0 0 8px;font-size:20px;color:#111111;">Workout Tracker</h1>
    <h2 style="margin:0 0 16px;font-size:17px;color:#333333;">Reset Your Password</h2>
    <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#444444;">
      We received a request to reset your password. Tap the button below to choose a new one.
    </p>
    <p style="margin:0 0 24px;text-align:center;">
      <a href="${resetUrl}"
         style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;
                font-size:15px;font-weight:700;padding:12px 28px;border-radius:8px;">
        RESET PASSWORD
      </a>
    </p>
    <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#555555;">
      If the button doesn't open the app, copy this code and paste it into the
      app's Reset Password screen:
    </p>
    <p style="margin:0 0 20px;">
      <code style="display:block;background:#f1f3f5;border-radius:6px;padding:10px 12px;
                   font-size:12px;word-break:break-all;color:#222222;">${resetUrl}</code>
    </p>
    <p style="margin:0 0 8px;font-size:13px;color:#666666;">
      This link will expire in ${expiresInMinutes} minutes.
    </p>
    <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#666666;">
      If you did not request a password reset, you can safely ignore this email.
    </p>
    <p style="margin:0 0 20px;font-size:13px;color:#666666;">
      For security reasons, do not share this link with anyone.
    </p>
    <p style="margin:0;font-size:13px;color:#888888;">Thanks,<br/>Workout Tracker Team</p>
  </div>
</body>
</html>`;

  const text = `
Reset your Workout Tracker password

We received a request to reset your password. Open the link below to
choose a new one:

${resetUrl}

This link will expire in ${expiresInMinutes} minutes.
If the link doesn't open the app, copy it and paste it into the app's
Reset Password screen.

If you did not request a password reset, you can safely ignore this email.
For security reasons, do not share this link with anyone.

Thanks,
Workout Tracker Team
`;

  return { subject, html, text };
}

module.exports = { passwordResetEmail, buildResetUrl };
