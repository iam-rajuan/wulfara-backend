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
   JWT_EXPIRE=30d

   AWS_REGION=your_aws_region
   AWS_ACCESS_KEY_ID=your_aws_access_key
   AWS_SECRET_ACCESS_KEY=your_aws_secret_key
   AWS_S3_BUCKET_NAME=your_bucket_name

   RESEND_API_KEY=your_resend_api_key
   EMAIL_FROM=onboarding@resend.dev
   ```

3. Run the server:
   ```bash
   # Run in development mode (with nodemon)
   npm run dev

   # Run in production mode
   npm start
   ```

## 🔒 API Security & Architecture
- **Role-Based Access Control (RBAC)**: Strict `protect` and `authorize` middlewares separate Buyer, Supplier, and Admin capabilities.
- **Data Sanitization**: Built-in protection against NoSQL injection.
- **Stateless Authentication**: Purely token-driven architecture ensuring extreme scalability.
- **Pre-signed S3 Uploads**: Files bypass the Node.js server and upload directly from the client to AWS, saving massive bandwidth and compute power.

---
*Developed with modern best practices for maximum performance and security.*
