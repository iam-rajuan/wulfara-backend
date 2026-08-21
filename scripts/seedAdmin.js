require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const { enforceProtectedSuperAdmins, syncAdminUserFromEnv } = require('../src/utils/adminSeed');

const seedAdmin = async () => {
  try {
    await connectDB();
    const result = await syncAdminUserFromEnv({ force: true });

    if (result.skipped) {
      console.log(`Admin seed skipped: ${result.reason}`);
    } else {
      result.results.forEach((item) => {
        console.log(`Admin seed ${item.action} for ${item.email} (${item.roleSlug})`);
      });
    }

    const protectedResults = await enforceProtectedSuperAdmins();
    protectedResults.forEach((item) => {
      console.log(`Protected role enforced for ${item.email} (${item.roleSlug})`);
    });
  } catch (error) {
    console.error('Admin seed failed:', error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
};

seedAdmin();
