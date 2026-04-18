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

// Helper to force 3 decimal places
const format3 = (val) => parseFloat(Number(val).toFixed(3));
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
            // Added ultra-stealth parameters to get past Rocket/USAA 500 errors
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&render=true&premium=true&country_code=us&session_number=${Math.floor(Math.random() * 1000)}`;
            
            const response = await axios.get(proxyUrl, { timeout: 120000 });
            let data = response.data;
            if (typeof data !== 'string') data = JSON.stringify(data);

            const cleanText = data
                .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, '')
                .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, '')
                .replace(/<[^>]*>/g, '|') // Using pipe to preserve "cell" boundaries
                .replace(/\s+/g, ' ');

            const configs = [
                { id: '30yr Conv', keys: ['30-Year Fixed', '30 Year Fixed', 'Conventional'] },
                { id: '30yr VA', keys: ['30-Year VA', 'VA Loan', 'VA Fixed'] }
            ];

            for (const conf of configs) {
                // Search for the product name
                const regex = new RegExp(`(${conf.keys.join('|')})([^|]{1,1500})`, 'i');
                const match = cleanText.match(regex);

                if (match) {
                    const block = match[2];
                    // Find all decimals in the block
                    const decimals = block.match(/(\d+\.\d+)/g);
                    
                    if (decimals) {
                        const nums = decimals.map(n => parseFloat(n));
                        
                        // 1. RATE: First number in 4.5-9.5 range
                        const rawRate = nums.find(n => isSaneRate(n));
                        
                        if (rawRate) {
                            // 2. APR: The next number in the range that isn't the rate
                            const rawApr = nums.find(n => isSaneRate(n) && n !== rawRate) || (rawRate + 0.22);
                            
                            // 3. POINTS: Look specifically for the word "Points" OR take the smallest decimal
                            let rawPoints = 0;
                            const pointWordMatch = block.match(/(?:points|discount|origination)[^|]{1,50}(\d+\.\d+)/i);
                            
                            if (pointWordMatch) {
                                rawPoints = parseFloat(pointWordMatch[1]);
                            } else {
                                // Fallback: Take the decimal that isn't Rate or APR
                                rawPoints = nums.find(n => n < 3.5 && n !== rawRate && n !== rawApr) || 0;
                            }

                            const rate = format3(rawRate);
                            const apr = format3(rawApr);
                            const points = format3(rawPoints);

                            results.push({
                                lender: lender.name, product: conf.id, date: today,
                                rate, apr, points, timestamp: admin.firestore.FieldValue.serverTimestamp()
                            });
                            console.log(`   ✅ ${conf.id}: Rate ${rate.toFixed(3)}% | APR ${apr.toFixed(3)}% | Pts ${points.toFixed(3)}`);
                        }
                    }
                }
            }
        } catch (err) {
            console.error(`   ❌ ERROR: ${lender.name} - ${err.message}`);
        }
    }

    if (results.length > 0) {
        const batch = db.batch();
        results.forEach(res => {
            const id = `${res.date}_${res.lender}_${res.product.replace(/\s/g, '_')}`;
            batch.set(db.collection('mortgage_rates').doc(id), res);
        });
        await batch.commit();
        console.log(`>>> SAVED: ${results.length} records.`);
    }
}

run();
