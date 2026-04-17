const { chromium } = require('playwright');
const admin = require('firebase-admin');

// 1. Initialize Firebase (Use Service Account from GitHub Secrets)
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

async function scrape() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0...' });
  const page = await context.newPage();

  const results = [];
  const lenders = [
    { name: 'PenFed', url: 'https://www.penfed.org/mortgage/mortgage-rates' },
    { name: 'Rocket', url: 'https://www.rocketmortgage.com/mortgage-rates' },
    { name: 'NFCU', url: 'https://www.navyfederal.org/loans-cards/mortgage/mortgage-rates.html' },
    { name: 'USAA', url: 'https://www.usaa.com/banking/home-mortgages/rates/' }
  ];

  for (const lender of lenders) {
    try {
      await page.goto(lender.url, { waitUntil: 'networkidle' });
      // Logic to find the specific 30yr VA and Conv rates
      // Example for a generic table find:
      const rate = await page.locator('text=30-Year VA').first().innerText(); 
      results.push({ lender: lender.name, date: new Date().toISOString().split('T')[0], rate });
    } catch (e) { console.log(`Error scraping ${lender.name}`); }
  }

  // 2. Push to Firestore
  for (const res of results) {
    await db.collection('mortgage_rates').add(res);
  }

  await browser.close();
}

scrape();
