const admin = require('firebase-admin');
const axios = require('axios');

const SCRAPER_KEY = process.env.SCRAPER_API_KEY;
const FIREBASE_KEY = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!SCRAPER_KEY || !FIREBASE_KEY) {
    console.error("Missing Secrets!");
    process.exit(1);
}

if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_KEY)) });
}
const db = admin.firestore();

// Helper: Only accepts numbers that look like current mortgage rates (5.5 - 8.5)
const isSaneRate = (val) => val >= 5.0 && val <= 9.0;

async function run() {
    const today = new Date().toISOString().split('T')[0];
    const results = [];

    const LENDERS = [
        { name: 'PenFed', url: 'https://www.penfed.org/mortgage/mortgage-rates' },
        { name: 'NFCU', url: 'https://www.navyfederal.org/loans-cards/mortgage/mortgage-rates.html' },
        { name: 'Rocket', url: 'https://www.rocketmortgage.com/mortgage-rates' },
        { name: 'USAA', url: 'https://www.usaa.com/banking/home-mortgages/rates/' }
    ];

    for (const lender of LENDERS) {
        console.log(`>>> PROXY FETCH: ${lender.name}`);
        try {
            // We force US proxies and add render_js=true
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&render=true&premium=true&country_code=us`;
            const response = await axios.get(proxyUrl, { timeout: 120000 });
            
            const raw = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            // Clean the HTML but keep some structure for table parsing
            const clean = raw.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/g, '')
                             .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/g, '')
                             .replace(/<[^>]*>/g, '|') 
                             .replace(/\s+/g, ' ');

            const products = [
                { id: '30yr Conv', keys: ['30-Year Fixed', 'Conventional'] },
                { id: '30yr VA', keys: ['VA Loan', 'VA Fixed', 'Veteran'] }
            ];

            for (const prod of products) {
                // Find a block of text around the product name
                const regex = new RegExp(`(${prod.keys.join('|')})[^|]{1,500}`, 'gi');
                const matches = clean.match(regex);

                if (matches) {
                    for (const block of matches) {
                        const decimals = block.match(/(\d+\.\d+)/g);
                        if (!decimals) continue;

                        const nums = decimals.map(n => parseFloat(n));
                        // Strategy: The Interest Rate is usually the first sane rate found.
                        const rate = nums.find(n => isSaneRate(n));
                        
                        if (rate) {
                            // APR is usually the number immediately following the rate that is slightly higher
                            const apr = nums.find(n => n > rate && n < rate + 1.0) || (rate + 0.25);
                            // Points are usually a small number < 3.0 that is NOT the rate or APR
                            const points = nums.find(n => n > 0 && n < 3.0 && n !== rate && n !== apr) || 0;

                            results.push({
                                lender: lender.name, product: prod.id, date: today,
                                rate, apr, points, timestamp: admin.firestore.FieldValue.serverTimestamp()
                            });
                            console.log(`   ✅ ${lender.name} ${prod.id}: ${rate}% | APR: ${apr}% | Pts: ${points}`);
                            break; // Stop after finding the first valid row for this product
                        }
                    }
                }
            }
        } catch (err) {
            console.error(`   ❌ ${lender.name} FAILED: ${err.message}`);
        }
    }

    if (results.length > 0) {
        console.log(`>>> UPDATING FIREBASE: ${results.length} records`);
        const batch = db.batch();
        results.forEach(res => {
            const id = `${res.date}_${res.lender}_${res.product.replace(/\s/g, '_')}`;
            batch.set(db.collection('mortgage_rates').doc(id), res);
        });
        await batch.commit();
    }
}

run();
