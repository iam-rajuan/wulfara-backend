const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM_EMAIL = 'Wulfara Support <noreply@wulfara.space>';

const sendEmail = async (options) => {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || DEFAULT_FROM_EMAIL;
  const replyTo = process.env.RESEND_REPLY_TO;

  if (!apiKey) {
    throw new Error('Resend credentials are missing. Set RESEND_API_KEY.');
  }

  if (!options?.email || !options?.subject || !options?.html) {
    throw new Error('sendEmail requires email, subject, and html.');
  }

  const payload = {
    from,
    to: [options.email],
    subject: options.subject,
    html: options.html,
  };

  if (replyTo) {
    payload.reply_to = replyTo;
  }

  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.message || data?.error || response.statusText || 'Unknown Resend error';
    throw new Error(`Resend email send failed: ${message}`);
  }

  return data;
};

module.exports = sendEmail;
