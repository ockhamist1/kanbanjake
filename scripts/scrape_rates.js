const { chromium } = require('playwright');
const admin = require('firebase-admin');

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error("Missing FIREBASE_SERVICE_ACCOUNT secret!");
    process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const grabNum = (text) => {
    const match = text.match(/(\d+\.\d+)/);
    return match ? parseFloat(match[1]) : 0;
};

async function scrapeLenders() {
    // Force HTTP/1.1 and add 'Stealth' arguments to bypass basic bot detection
    const browser = await chromium.launch({ 
        headless: true,
        args: [
            '--disable-http2', 
            '--disable-blink-features=AutomationControlled',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
        ]
    });

    const today = new Date().toISOString().split('T')[0];
    const results = [];

    const lenders = [
        { name: 'PenFed', url: 'https://www.penfed.org/mortgage/mortgage-rates' },
        { name: 'NFCU', url: 'https://www.navyfederal.org/loans-cards/mortgage/mortgage-rates.html' },
        { name: 'Rocket', url: 'https://www.rocketmortgage.com/am-i-ready-to-buy/mortgage-rates' },
        { name: 'USAA', url: 'https://www.usaa.com/banking/home-mortgages/rates/' }
    ];

    for (const lender of lenders) {
        console.log(`--- Attempting ${lender.name} ---`);
        
        // ISOLATION: Create a brand new browser context for EACH lender
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
            // Wait for 'networkidle' to ensure JS rates have rendered
            await page.goto(lender.url, { waitUntil: 'networkidle', timeout: 45000 });
            await page.waitForTimeout(3000); // Small human-like pause

            const products = [
                { type: '30yr VA', keywords: ['VA', 'Veteran'] },
                { type: '30yr Conv', keywords: ['30-Year Fixed', '30-Yr Fixed', 'Conventional'] }
            ];

            for (const prod of products) {
                // Look specifically for table cells or divs that likely hold rates
                const locator = page.locator(`tr:has-text("${prod.keywords[0]}"), div:has-text("${prod.keywords[0]}")`).first();
                
                if (await locator.count() > 0) {
                    const content = await locator.innerText();
                    const numbers = content.match(/(\d+\.\d+)%/g); 
                    
                    if (numbers && numbers.length >= 1) {
                        const rate = grabNum(numbers[0]);
                        const apr = numbers.length >= 2 ? grabNum(numbers[1]) : rate + 0.25; // Fallback if APR hidden
                        
                        results.push({
                            lender: lender.name,
                            product: prod.type,
                            date: today,
                            rate: rate,
                            apr: apr,
                            points: 0,
                            timestamp: admin.firestore.FieldValue.serverTimestamp()
                        });
                        console.log(`✅ ${lender.name} ${prod.type}: ${rate}%`);
                    }
                }
            }
        } catch (err) {
            console.error(`❌ ${lender.name} blocked us: ${err.message.split('\n')[0]}`);
        } finally {
            await context.close(); // Clean up context before moving to next lender
        }
    }

    if (results.length > 0) {
        console.log(`Success! Pushing ${results.length} updates to Firebase.`);
        const batch = db.batch();
        results.forEach(res => {
            const docId = `${res.date}_${res.lender}_${res.product.replace(/\s/g, '_')}`;
            batch.set(db.collection('mortgage_rates').doc(docId), res);
        });
        await batch.commit();
    }

    await browser.close();
}

scrapeLenders();
