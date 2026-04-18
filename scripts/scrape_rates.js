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

// Sane range for today's market (4.5% to 9.5%)
const isSaneRate = (val) => val >= 4.5 && val <= 9.5;

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
        console.log(`>>> FETCHING: ${lender.name}`);
        try {
            // Using PREMIUM + US PROXY + RENDER + EXTRA WAIT
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&render=true&premium=true&country_code=us&wait_until=networkidle`;
            
            // Increased timeout to 120 seconds per lender
            const response = await axios.get(proxyUrl, { timeout: 120000 });
            console.log(`<<< SUCCESS: ${lender.name} (Bytes: ${JSON.stringify(response.data).length})`);
            
            const raw = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            // Clean up tags but preserve some spacing
            const clean = raw.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/g, '')
                             .replace(/<[^>]*>/g, '|')
                             .replace(/\s+/g, ' ');

            const configs = [
                { id: '30yr Conv', keys: ['Conventional', '30-Year Fixed', '30 Year Fixed'] },
                { id: '30yr VA', keys: ['VA Loan', 'VA Fixed', 'Veteran', 'VA 30'] }
            ];

            for (const conf of configs) {
                // Find all text blocks around these keywords
                const regex = new RegExp(`(${conf.keys.join('|')})[^|]{1,1000}`, 'gi');
                const matches = clean.match(regex);

                if (matches) {
                    for (const block of matches) {
                        const decimals = block.match(/(\d+\.\d+)/g);
                        if (!decimals) continue;

                        const nums = decimals.map(n => parseFloat(n));
                        const rate = nums.find(n => isSaneRate(n));
                        
                        if (rate) {
                            const apr = nums.find(n => n > rate && n < rate + 1.2) || (rate + 0.23);
                            const points = nums.find(n => n > 0 && n < 3.0 && n !== rate && n !== apr) || 0;

                            results.push({
                                lender: lender.name, product: conf.id, date: today,
                                rate, apr, points, timestamp: admin.firestore.FieldValue.serverTimestamp()
                            });
                            console.log(`   ✅ ${conf.id}: ${rate}% (Points: ${points})`);
                            break; // Stop once we find the first valid match for this product
                        }
                    }
                }
            }
        } catch (err) {
            console.error(`   ❌ ERROR: ${lender.name} - ${err.message}`);
        }
    }

    if (results.length > 0) {
        console.log(`>>> SAVING TO FIREBASE: ${results.length} records`);
        const batch = db.batch();
        results.forEach(res => {
            const id = `${res.date}_${res.lender}_${res.product.replace(/\s/g, '_')}`;
            batch.set(db.collection('mortgage_rates').doc(id), res);
        });
        await batch.commit();
        console.log(">>> UPDATE COMPLETE.");
    }
}

run();
