const nodemailer = require('nodemailer');

const sendEmail = async (options) => {
  const emailAddress = process.env.EMAIL_FROM_ADDRESS;
  const emailPassword = process.env.EMAIL_PASSWORD;

  if (!emailAddress || !emailPassword) {
    throw new Error('Gmail SMTP credentials are missing. Set EMAIL_FROM_ADDRESS and EMAIL_PASSWORD.');
  }

  // Create a transporter using Gmail SMTP
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: emailAddress,
      pass: emailPassword, // Must be a Gmail App Password, not the regular Gmail password
    },
  });

  const mailOptions = {
    from: `"Wulfara Support" <${emailAddress}>`,
    to: options.email,
    subject: options.subject,
    html: options.html,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    return info;
  } catch (error) {
    console.error('Error sending email via Nodemailer:', error);
    if (error.code === 'EAUTH') {
      throw new Error('Gmail SMTP authentication failed. Check EMAIL_FROM_ADDRESS and Gmail App Password.');
    }

    throw new Error('Email could not be sent');
  }
};

module.exports = sendEmail;
