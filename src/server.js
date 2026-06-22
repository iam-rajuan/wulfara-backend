require('dotenv').config();
const connectDB = require('./config/db');
const app = require('./app');

// Connect to database
connectDB();

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection! Shutting down...', err);
  server.close(() => {
    process.exit(1);
  });
});
