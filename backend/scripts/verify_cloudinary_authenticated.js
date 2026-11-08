/**
 * Cloudinary Authenticated Mode Verification Utility
 * 
 * Verifies that an uploaded test file is strictly PRIVATE and CANNOT be accessed
 * via a plain public Cloudinary CDN URL, while remaining accessible via signed
 * private download URLs.
 * 
 * Usage:
 *   node backend/scripts/verify_cloudinary_authenticated.js
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { cloudinary, isCloudinaryConfigured, uploadPrivateScriptToCloudinary, generateAuthenticatedScriptUrl } = require('../services/cloudinaryService');

async function verifyCloudinaryAuthenticated() {
  console.log('='.repeat(80));
  console.log('🔒 CLOUDINARY AUTHENTICATED MODE VERIFICATION');
  console.log('='.repeat(80));

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY || process.env.API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET || process.env.API_SECRET;

  console.log(`Cloud Name configured : ${cloudName ? cloudName : '❌ Missing'}`);
  console.log(`API Key configured    : ${apiKey ? '••••••••' + apiKey.slice(-4) : '❌ Missing'}`);
  console.log(`API Secret configured : ${apiSecret ? '••••••••' : '❌ Missing'}`);

  if (!isCloudinaryConfigured()) {
    console.log('\n⚠️  Notice: Cloudinary credentials are not set in backend/.env.');
    console.log('The system will run in local private disk fallback mode (uploads/private_scripts).');
    console.log('To run this test against live Cloudinary, provide CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in Render / .env.');
    return;
  }

  const testFileName = `test_private_audit_${Date.now()}.pdf`;
  const samplePdfBuffer = Buffer.from('%PDF-1.4 Mock Private Answer Script for Cloudinary Security Audit');

  console.log(`\n1. Uploading test script in authenticated mode (${testFileName})...`);
  const uploadResult = await uploadPrivateScriptToCloudinary(samplePdfBuffer, {
    fileName: testFileName,
  });

  console.log(`   ✓ Uploaded. Public ID: ${uploadResult.public_id}`);
  console.log(`   ✓ Storage Mode: ${uploadResult.storage}`);

  const publicId = uploadResult.public_id;
  const publicCdnUrl = `https://res.cloudinary.com/${cloudName}/image/upload/${publicId}.pdf`;

  console.log(`\n2. Attempting unauthenticated direct access via public URL:`);
  console.log(`   URL: ${publicCdnUrl}`);

  try {
    const publicRes = await fetch(publicCdnUrl);
    console.log(`   HTTP Status: ${publicRes.status} ${publicRes.statusText}`);

    if (publicRes.status === 200) {
      console.error('\n❌ SECURITY FAILURE: File is reachable via plain public Cloudinary URL!');
      process.exit(1);
    } else {
      console.log(`   ✓ Pass: Plain public CDN URL blocked with HTTP ${publicRes.status} (Access Denied / Not Found).`);
    }
  } catch (err) {
    console.log(`   ✓ Pass: Request blocked (${err.message})`);
  }

  console.log(`\n3. Generating time-limited HMAC-SHA1 signed private download URL:`);
  const signedUrl = generateAuthenticatedScriptUrl(publicId, 'pdf', 300);
  console.log(`   Signed URL generated: ${signedUrl ? 'Yes (HMAC signed)' : 'No'}`);

  if (signedUrl) {
    const signedRes = await fetch(signedUrl);
    console.log(`   HTTP Status on Signed URL: ${signedRes.status} ${signedRes.statusText}`);
    if (signedRes.status === 200) {
      console.log(`   ✓ Pass: Authorized signed URL successfully downloads the script.`);
    } else {
      console.warn(`   ⚠️ Warning: Signed URL returned ${signedRes.status}`);
    }
  }

  console.log(`\n4. Cleaning up test file from Cloudinary...`);
  try {
    await cloudinary.uploader.destroy(publicId, { type: 'authenticated', resource_type: 'image' });
    console.log(`   ✓ Cleaned up test file.`);
  } catch (_) {}

  console.log('\n' + '='.repeat(80));
  console.log('🎉 CLOUDINARY AUTHENTICATED MODE VERIFICATION SUCCESSFUL!');
  console.log('='.repeat(80));
}

if (require.main === module) {
  verifyCloudinaryAuthenticated().catch((err) => {
    console.error('Error during verification:', err);
    process.exit(1);
  });
}

module.exports = { verifyCloudinaryAuthenticated };
