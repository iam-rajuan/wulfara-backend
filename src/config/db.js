const mongoose = require('mongoose');
const dns = require('dns');
const { logger } = require('../utils/logger');

const fallbackDnsServers = ['8.8.8.8', '1.1.1.1'];

const connectMongo = () => mongoose.connect(process.env.MONGO_URI);

const connectDB = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error(
      'MONGO_URI is not set. Create a .env file from .env.example before running the server.'
    );
  }

  try {
    const conn = await connectMongo();
    logger.info({ host: conn.connection.host }, 'MongoDB connected');
  } catch (error) {
    logger.warn({ err: error }, 'MongoDB connection failed with default DNS');
    logger.warn({ dnsServers: fallbackDnsServers }, 'Retrying MongoDB connection with fallback DNS servers');

    dns.setServers(fallbackDnsServers);

    try {
      const conn = await connectMongo();
      logger.info({ host: conn.connection.host }, 'MongoDB connected');
    } catch (fallbackError) {
      logger.error({ err: fallbackError }, 'Error connecting to MongoDB');
      process.exit(1);
    }
  }
};

module.exports = connectDB;
