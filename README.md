# 🚀 B2B SaaS Platform API

A robust, scalable backend architecture for a B2B Supplier Directory & RFQ (Request For Quotation) SaaS Platform. Built with Node.js, Express, and MongoDB, this platform connects buyers with certified suppliers, enabling secure communications, file sharing via AWS S3, and premium subscription tiers.

---

## 🌟 Key Features
- **Role-Based Authentication**: Secure JWT auth with roles for `buyer`, `supplier`, and `admin`.
- **Supplier Directory**: Dynamic supplier profiles with categories, products, and verified status.
- **RFQ System**: Allow buyers to submit Requests for Quotations directly to suppliers.
- **Cloud Storage (AWS S3)**: Secure pre-signed URLs for direct-to-cloud uploads (saving server bandwidth).
- **Email Integration**: Password resets and email verifications using Resend API.
- **SaaS Subscriptions**: Foundation for tiered plans (Free, Premium) with simulated Stripe checkout.

---

## 🛠 Technology Stack
- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: MongoDB (via Mongoose ODM)
- **Authentication**: JWT (JSON Web Tokens) & bcryptjs
- **Storage**: AWS SDK v3 (S3 Pre-signed URLs)
- **Emails**: Resend API
- **Security**: Helmet, Express Validator, CORS

---

## ⚙️ Getting Started

### Prerequisites
Make sure you have installed:
- Node.js (v14 or higher)
- MongoDB Atlas Account (or local MongoDB)
- AWS Account (for S3 storage)
- Resend Account (for sending emails)

### Installation
1. Clone the repository and install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory based on `.env.example`:
```env
PORT=5000
MONGO_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/dbname
JWT_SECRET=supersecretjwtkey12345
JWT_EXPIRES_IN=30d
RESEND_API_KEY=re_your_api_key

# AWS S3 Settings
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_S3_BUCKET_NAME=your_bucket_name
```

3. Start the development server (uses Nodemon for hot-reloading):
```bash
npm run dev
```

---

## 📚 API Endpoints Overview

The base URL for the API is `http://localhost:5000/api/v1`.

### 🔐 1. Authentication (`/auth`)
| Method | Endpoint | Description | Access |
|---|---|---|---|
| POST | `/auth/register` | Register new user | Public |
| POST | `/auth/verify-email` | Verify email with 6-digit code | Public |
| POST | `/auth/login` | Login user & return JWT | Public |
| POST | `/auth/forgot-password` | Request password reset token | Public |
| PUT | `/auth/reset-password/:token` | Reset password using token | Public |

### 👥 2. Users (`/users`)
| Method | Endpoint | Description | Access |
|---|---|---|---|
| GET | `/users/me` | Get current logged in user | Auth |
| GET | `/users` | Get all users | Admin |
| GET | `/users/:id` | Get single user | Admin |
| PUT | `/users/:id` | Update user details/status | Admin |
| DELETE | `/users/:id` | Delete user | Admin |

### 🏷️ 3. Categories (`/categories`)
| Method | Endpoint | Description | Access |
|---|---|---|---|
| GET | `/categories` | Get all supplier categories | Public |
| GET | `/categories/:id` | Get single category | Public |
| POST | `/categories` | Create new category | Admin |
| PUT | `/categories/:id` | Update category | Admin |
| DELETE | `/categories/:id` | Delete category | Admin |

### 🏢 4. Suppliers (`/suppliers`)
| Method | Endpoint | Description | Access |
|---|---|---|---|
| GET | `/suppliers` | Get all approved suppliers | Public |
| GET | `/suppliers/:id` | Get single supplier profile | Public |
| POST | `/suppliers` | Create supplier profile | Supplier/Admin |
| PUT | `/suppliers/:id` | Update supplier profile | Owner/Admin |
| DELETE | `/suppliers/:id` | Delete supplier profile | Owner/Admin |
| POST | `/suppliers/upload-url` | Get AWS S3 Pre-signed URL | Supplier/Admin |

### 📩 5. RFQs (`/rfqs`)
| Method | Endpoint | Description | Access |
|---|---|---|---|
| POST | `/rfqs` | Submit RFQ to a supplier | Public |
| GET | `/rfqs/supplier` | View received RFQs | Supplier/Admin |
| PUT | `/rfqs/:id/status`| Update RFQ status (pending/reviewed)| Supplier/Admin |

### 💳 6. Subscriptions (`/subscriptions`)
| Method | Endpoint | Description | Access |
|---|---|---|---|
| POST | `/subscriptions/checkout-session`| Generate Checkout URL | Supplier |
| GET | `/subscriptions/simulate-payment`| Simulate Stripe Webhook | Public |

---

## 🔮 Future Improvements
*   Replace simulated subscription endpoint with official Stripe API (`stripe.checkout.sessions.create`).
*   Implement real-time WebSocket notifications (Socket.io) for new RFQs.
*   Add automated PDF Generation for generating official quotes.

> Developed with ❤️ as a modern B2B SaaS Foundation.
