require('dotenv').config();
const connectDB = require('./config/db');
const app = require('./app');
const { logger } = require('./utils/logger');
const { enforceProtectedSuperAdmins, syncAdminUserFromEnv } = require('./utils/adminSeed');
const { assignFallbackAdminRoles, seedDefaultAdminRoles } = require('./modules/adminRoles/adminRole.service');
const { buildSocketCorsOptions } = require('./utils/origins');

const { Server } = require('socket.io');

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await connectDB();
    await seedDefaultAdminRoles();
    await assignFallbackAdminRoles();
    await syncAdminUserFromEnv();
    await enforceProtectedSuperAdmins();
    app.set('trust proxy', 1);

    const server = app.listen(PORT, () => {
      logger.info({ port: PORT }, 'Server is running');
    });

    const io = new Server(server, {
      cors: buildSocketCorsOptions(),
    });

    // Expose io to routes/controllers
    app.set('io', io);

    io.on('connection', (socket) => {
      logger.info({ socketId: socket.id }, 'Socket connected');
      
      socket.on('join_room', (roomId) => {
        socket.join(roomId);
        logger.info({ socketId: socket.id, roomId }, 'Socket joined room');
      });

      socket.on('send_message', (data) => {
        // Broadcast to everyone else in the room
        socket.to(data.roomId).emit('receive_message', data);
      });

      socket.on('disconnect', () => {
        logger.info({ socketId: socket.id }, 'Socket disconnected');
      });
    });
  } catch (error) {
    logger.error({ err: error }, error.message);
    process.exit(1);
  }
};

startServer();

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'Unhandled Rejection! Shutting down...');
  process.exit(1);
});
