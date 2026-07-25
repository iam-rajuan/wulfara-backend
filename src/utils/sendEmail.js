const nodemailer = require('nodemailer');

const sendEmail = async (options) => {
  // Create a transporter using Gmail SMTP
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_FROM_ADDRESS,
      pass: process.env.EMAIL_PASSWORD, // Must be an App Password, not the regular Gmail password
    },
  });

  const mailOptions = {
    from: `"Wulfara Support" <${process.env.EMAIL_FROM_ADDRESS}>`,
    to: options.email,
    subject: options.subject,
    html: options.html,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    return info;
  } catch (error) {
    console.error('Error sending email via Nodemailer:', error);
    throw new Error('Email could not be sent');
  }
};

module.exports = sendEmail;
