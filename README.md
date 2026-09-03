# B2B SaaS Platform Backend 🚀

A highly scalable, secure, and fully-featured backend engine for a B2B matching and RFQ (Request for Quotation) platform. Built with Node.js, Express, MongoDB, and AWS S3.

## 📖 Overview
This RESTful API powers a multi-sided marketplace connecting **Buyers** and **Suppliers**. It handles complex workflows including user authentication, company profiling, real-time RFQ routing, in-app messaging, Stripe-simulated subscriptions, and a powerful Admin dashboard.

## ✨ Features

### 👤 Buyer (Public) Features
- **Browse & Search**: Access the global supplier directory and search by categories.
- **RFQ Engine**: Submit complex Request for Quotations (RFQs) directly to suppliers.
- **Favorites System**: Save and bookmark preferred suppliers for quick access.
- **RFQ Tracking**: Logged-in buyers can track the status of all sent RFQs.
- **Email Notifications**: Automated email confirmations upon RFQ submission (powered by Resend).

### 🏢 Supplier Features
- **Company Profiling**: Create rich company listings with logos, descriptions, and categorized product/service offerings.
- **Cloud Storage**: Seamless image/logo uploads powered by AWS S3 Presigned URLs.
- **RFQ Management**: Receive, view, and respond to RFQs.
- **In-App Messaging**: Threaded messaging system directly tied to RFQs to communicate with buyers.
- **Analytics Dashboard**: Track profile completion, total RFQs received, and pending tasks.
- **Subscription Tiers**: Upgrade capabilities through dynamic pricing plans (simulated via Stripe).
- **Invoice Tracking**: View past payment history and invoices.

### 🛡️ Admin Features
- **Global Overview**: Monitor all platform RFQs, users, and suppliers.
- **Account Control**: Suspend/Activate users and feature top-performing suppliers.
- **Dynamic Pricing**: Full CRUD control over subscription pricing tiers and features.
- **Content Management System (CMS)**: Manage dynamic homepage banners and static SEO pages.
- **Advanced Reporting**: Aggregated dashboard displaying total revenue, platform growth, and active volume.

## 🛠️ Technology Stack
- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: MongoDB (Mongoose ODM)
- **Authentication**: JWT (JSON Web Tokens) & bcryptjs
- **Storage**: Amazon S3 (AWS SDK v3)
- **Emails**: Resend API

## 🚀 Getting Started

### Prerequisites
- Node.js (v16+)
- MongoDB Atlas URI
- AWS Account (S3 Bucket credentials)
- Resend API Key

### Installation

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```

2. Configure environment variables. Create a `.env` file in the root directory:
   ```env
   NODE_ENV=development
   PORT=5000
   MONGO_URI=your_mongodb_connection_string

   JWT_SECRET=your_jwt_secret_key
   JWT_EXPIRES_IN=30d

   AWS_REGION=your_aws_region
   AWS_ACCESS_KEY_ID=your_aws_access_key
   AWS_SECRET_ACCESS_KEY=your_aws_secret_key
   AWS_S3_BUCKET_NAME=your_bucket_name

   RESEND_API_KEY=your_resend_api_key
   RESEND_FROM_EMAIL=Wulfara Support <noreply@wulfara.space>
   RESEND_REPLY_TO=support@wulfara.space

   STRIPE_MODE=test
   STRIPE_SECRET_KEY=your_stripe_secret_key
   STRIPE_WEBHOOK_SECRET=your_stripe_webhook_secret
   WEBSITE_ORIGIN=https://www.your-website.com
   DASHBOARD_ORIGIN=https://dashboard.your-website.com

   SUPER_ADMIN_SEED_NAME=
   SUPER_ADMIN_SEED_EMAIL=support@example.com
   SUPER_ADMIN_SEED_PASSWORD=change_me
   SUPER_ADMIN_SEED_NAME_2=
   SUPER_ADMIN_SEED_EMAIL_2=founder@example.com
   SUPER_ADMIN_SEED_PASSWORD_2=change_me
   SUPER_ADMIN_LOCKED_EMAILS=support@example.com,founder@example.com,legacy-admin@example.com

   ADMIN_SEED_NAME=
   ADMIN_SEED_EMAIL=admin@example.com
   ADMIN_SEED_PASSWORD=change_me
   ADMIN_SEED_ROLE_SLUG=admin
   ADMIN_SEED_SYNC_ON_START=false
   ```

3. Run the server:
   ```bash
   # Run in development mode (with nodemon)
   npm run dev

   # Run in production mode
   npm start
   ```

4. Seed or sync the admin account from `.env`:
   ```bash
   npm run seed:admin
   ```

   Set `ADMIN_SEED_SYNC_ON_START=true` if you want the backend to keep the admin email/password in sync with `.env` every time the server starts.

### Stripe webhook setup

- The checkout session endpoint is `POST /api/v1/subscriptions/checkout-session`.
- The Stripe webhook endpoint is `POST /api/v1/subscriptions/webhook`.
- A compatibility alias is also available at `POST /webhooks/stripe` if your Stripe endpoint is already pointed there.
- In local development with ngrok, point Stripe to `https://<your-ngrok-host>/api/v1/subscriptions/webhook` or `https://<your-ngrok-host>/webhooks/stripe`.
- `STRIPE_MODE` may be `test` or `live`. If omitted, the backend infers the mode from `STRIPE_SECRET_KEY` when possible.
- `STRIPE_SECRET_KEY` is required to create checkout sessions and must match `STRIPE_MODE`.
- `STRIPE_WEBHOOK_SECRET` is required to verify Stripe webhook signatures safely and is mandatory in production.

## 🔒 API Security & Architecture
- **Role-Based Access Control (RBAC)**: Strict `protect` and `authorize` middlewares separate Buyer, Supplier, and Admin capabilities.
- **Data Sanitization**: Built-in protection against NoSQL injection.
- **Stateless Authentication**: Purely token-driven architecture ensuring extreme scalability.
- **Pre-signed S3 Uploads**: Files bypass the Node.js server and upload directly from the client to AWS, saving massive bandwidth and compute power.

## 📡 API Endpoints & Postman Testing Guide

### 1. Authentication
*Base URL: `/api/v1/auth`*

- **Register User** (`POST /register`)
  ```json
  {
    "name": "Jane Buyer",
    "email": "jane@example.com",
    "password": "password123",
    "role": "buyer" // "buyer" or "supplier"
  }
  ```
- **Login User** (`POST /login`)
  ```json
  {
    "email": "jane@example.com",
    "password": "password123"
  }
  ```
- **Get Current User** (`GET /me`) - *Requires Bearer Token*

### 2. Suppliers
*Base URL: `/api/v1/suppliers`*

- **Create Supplier Profile** (`POST /`) - *Requires Supplier Bearer Token*
  ```json
  {
    "companyName": "Tech Supplies Inc.",
    "description": "Premium wholesale electronics.",
    "contactEmail": "sales@techsupplies.com",
    "contactPhone": "123-456-7890",
    "logo": "https://s3.amazonaws.com/bucket/logo.png"
  }
  ```
- **Get All Approved Suppliers** (`GET /`)
- **Get Supplier Dashboard Analytics** (`GET /dashboard`) - *Requires Supplier Bearer Token*

### 3. RFQs (Request for Quotations)
*Base URL: `/api/v1/rfqs`*

- **Submit RFQ to a Supplier** (`POST /`)
  ```json
  {
    "supplierId": "<SUPPLIER_PROFILE_ID_HERE>",
    "buyerName": "Jane Buyer",
    "buyerEmail": "jane@example.com",
    "subject": "Quote for 500 Laptops",
    "message": "Please provide pricing and shipping times."
  }
  ```
- **Get Buyer's Sent RFQs** (`GET /buyer`) - *Requires Buyer Bearer Token*
- **Get Supplier's Received RFQs** (`GET /supplier`) - *Requires Supplier Bearer Token*
- **Reply to an RFQ** (`POST /:id/messages`) - *Requires Bearer Token*
  ```json
  {
    "text": "We can offer a 10% discount on that volume."
  }
  ```

### 4. Admin Management
*Requires Admin Bearer Token*

- **Approve a Supplier Listing** (`PUT /api/v1/suppliers/:id/approve`)
  ```json
  { "isApproved": true }
  ```
- **Suspend a User Account** (`PUT /api/v1/auth/users/:id/status`)
  ```json
  { "isActive": false }
  ```
- **View Master Analytics Dashboard** (`GET /api/v1/reports/dashboard`)
- **Create Pricing Plan** (`POST /api/v1/subscriptions/plans`)
  ```json
  {
    "name": "Premium Tier",
    "price": 49.99,
    "features": ["Priority Ranking", "Analytics Dashboard", "Unlimited RFQs"]
  }
  ```

---
*Developed with modern best practices for maximum performance and security.*
