const { chromium } = require('playwright');
const admin = require('firebase-admin');

// 1. Initialize Firebase using the Secret from GitHub
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error("Missing FIREBASE_SERVICE_ACCOUNT secret!");
    process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Helper to clean strings like "6.125%" or "$7,000" into numbers
const cleanNum = (str) => {
    if (!str) return 0;
    return parseFloat(str.replace(/[^0-9.]/g, '')) || 0;
};

async function scrapeLenders() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    const today = new Date().toISOString().split('T')[0];
    const results = [];

    const lenders = [
        { name: 'PenFed', url: 'https://www.penfed.org/mortgage/mortgage-rates' },
        { name: 'NFCU', url: 'https://www.navyfederal.org/loans-cards/mortgage/mortgage-rates.html' },
        { name: 'Rocket', url: 'https://www.rocketmortgage.com/rate-updates' },
        { name: 'USAA', url: 'https://www.usaa.com/banking/home-mortgages/rates/' }
    ];

    for (const lender of lenders) {
        console.log(`Scraping ${lender.name}...`);
        try {
            await page.goto(lender.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            
            // Allow a few seconds for dynamic rates to pop in
            await page.waitForTimeout(3000);

            let products = [
                { type: '30yr VA', search: '30-Year VA' },
                { type: '30yr Conv', search: '30-Year Fixed' }
            ];

            for (const prod of products) {
                let rate = 0, apr = 0, points = 0;

                // LENDER SPECIFIC PARSING LOGIC
                if (lender.name === 'PenFed') {
                    // PenFed often lists rates in cards or simple tables
                    const container = page.locator(`.cmp-rate-card:has-text("${prod.search}")`).first();
                    rate = cleanNum(await container.locator('.rate-value').innerText());
                    apr = cleanNum(await container.locator('.apr-value').innerText());
                    // PenFed sometimes hides points in disclosures; default to 0 or adjust if visible
                } 
                
                else if (lender.name === 'NFCU') {
                    // Navy Federal uses standard HTML tables
                    const row = page.locator(`tr:has-text("${prod.search}")`).first();
                    rate = cleanNum(await row.locator('td').nth(1).innerText());
                    points = cleanNum(await row.locator('td').nth(2).innerText());
                    apr = cleanNum(await row.locator('td').nth(3).innerText());
                }

                else if (lender.name === 'Rocket') {
                    // Rocket uses list items with clear text labels
                    const li = page.locator(`li:has-text("${prod.search}")`).first();
                    const fullText = await li.innerText(); 
                    // Regex capture: Rate 6.5% APR 6.8% Points 1.5
                    rate = cleanNum(fullText.match(/Rate\s+([\d.]+)/)?.[1]);
                    apr = cleanNum(fullText.match(/APR\s+([\d.]+)/)?.[1]);
                    points = cleanNum(fullText.match(/Points\s+([\d.]+)/)?.[1]);
                }

                else if (lender.name === 'USAA') {
                    // USAA uses specific tables for purchase/refi
                    const table = page.locator(`table:has-text("${prod.search}")`).first();
                    rate = cleanNum(await table.locator('tr:has-text("Interest rate") td').innerText());
                    apr = cleanNum(await table.locator('tr:has-text("APR") td').innerText());
                    points = cleanNum(await table.locator('tr:has-text("Points") td').innerText());
                }

                if (rate > 0) {
                    results.push({
                        lender: lender.name,
                        product: prod.type,
                        date: today,
                        rate: rate,
                        apr: apr,
                        points: points,
                        timestamp: admin.firestore.FieldValue.serverTimestamp()
                    });
                }
            }
        } catch (err) {
            console.error(`Error with ${lender.name}:`, err.message);
        }
    }

    // 2. Batch write to Firestore
    if (results.length > 0) {
        console.log(`Saving ${results.length} records to Firebase...`);
        const batch = db.batch();
        results.forEach(res => {
            const docRef = db.collection('mortgage_rates').doc(`${res.date}_${res.lender}_${res.product.replace(/\s/g, '_')}`);
            batch.set(docRef, res);
        });
        await batch.commit();
        console.log("Database updated successfully.");
    } else {
        console.warn("No rates were found. Check locators.");
    }

    await browser.close();
}

scrapeLenders().catch(console.error);
