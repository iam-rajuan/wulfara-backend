const Notification = require('../modules/notifications/notification.model');
const sendEmail = require('./sendEmail');
const User = require('../modules/users/user.model');

/**
 * Creates a notification, saves it to the DB, emits via Socket.io, and optionally sends an email.
 *
 * @param {Object} req - The Express request object (used to get `req.app.get('io')`).
 * @param {String} userId - The ID of the user to notify.
 * @param {String} title - Notification title.
 * @param {String} message - Notification message.
 * @param {String} type - Notification type ('rfq', 'message', 'approval', 'system').
 * @param {String} relatedId - (Optional) ID of the related resource.
 */
const createNotification = async (req, userId, title, message, type = 'system', relatedId = null) => {
  try {
    // 1. Save to DB
    const notification = await Notification.create({
      user: userId,
      title,
      message,
      type,
      relatedId,
    });

    // 2. Emit via Socket.io
    const io = req.app.get('io');
    if (io) {
      // Emit to the user's specific room
      io.to(userId.toString()).emit('new_notification', notification);
    }

    // 3. Send automated email (run asynchronously so it doesn't block)
    User.findById(userId).then((user) => {
      if (user && user.email) {
        const emailHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>${title}</h2>
            <p>${message}</p>
            <p>Log in to your Wulfara dashboard to view more details.</p>
          </div>
        `;
        sendEmail({
          email: user.email,
          subject: `Wulfara Notification: ${title}`,
          html: emailHtml,
        }).catch(err => console.error('Error sending notification email:', err));
      }
    });

    return notification;
  } catch (error) {
    console.error('Error in createNotification service:', error);
  }
};

module.exports = {
  createNotification,
};
