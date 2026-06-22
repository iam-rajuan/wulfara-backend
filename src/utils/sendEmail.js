const { Resend } = require('resend');

const sendEmail = async (options) => {
  // Initialize here to ensure process.env is loaded
  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    const data = await resend.emails.send({
      from: 'onboarding@resend.dev', // Default testing address
      to: options.email,
      subject: options.subject,
      html: options.html
    });
    return data;
  } catch (error) {
    console.error('Error sending email:', error);
    throw new Error('Email could not be sent');
  }
};

module.exports = sendEmail;
