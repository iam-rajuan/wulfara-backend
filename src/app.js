const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();

// Middlewares
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic route for health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Server is running' });
});

// Modular routes will be mounted here
const authRoutes = require('./modules/auth/auth.routes');
const userRoutes = require('./modules/users/user.routes');
const categoryRoutes = require('./modules/categories/category.routes');
const supplierRoutes = require('./modules/suppliers/supplier.routes');
const rfqRoutes = require('./modules/rfqs/rfq.routes');
const subscriptionRoutes = require('./modules/subscriptions/subscription.routes');

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/categories', categoryRoutes);
app.use('/api/v1/suppliers', supplierRoutes);
app.use('/api/v1/rfqs', rfqRoutes);
app.use('/api/v1/subscriptions', subscriptionRoutes);
// ...

// 404 Error handler
app.use((req, res, next) => {
  res.status(404).json({ error: 'Not Found', message: 'The requested resource could not be found' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    message: err.message || 'Something went wrong',
  });
});

module.exports = app;
