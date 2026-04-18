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
            // OPTIMIZATION: keep_headers=true and binary_target=false to speed up the proxy
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&render=true&premium=true&country_code=us&wait_until=domcontentloaded`;
            
            const response = await axios.get(proxyUrl, { timeout: 120000 });
            let data = response.data;
            if (typeof data !== 'string') data = JSON.stringify(data);

            // Strip the noise but keep the pipe | for column separation
            const cleanText = data
                .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, '')
                .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, '')
                .replace(/<[^>]*>/g, '|')
                .replace(/\s+/g, ' ');

            const configs = [
                { id: '30yr Conv', keys: ['30-Year Fixed', '30 Year Fixed', 'Conventional'] },
                { id: '30yr VA', keys: ['30-Year VA', 'VA Loan', 'VA Fixed', 'Veteran'] }
            ];

            for (const conf of configs) {
                const regex = new RegExp(`(${conf.keys.join('|')})([^|]{1,2000})`, 'i');
                const match = cleanText.match(regex);

                if (match) {
                    const block = match[2];
                    const decimals = block.match(/(\d+\.\d+)/g);
                    
                    if (decimals && decimals.length >= 1) {
                        const nums = decimals.map(n => parseFloat(n));
                        
                        // 1. RATE: First number between 4.5 and 9.5
                        const rawRate = nums.find(n => isSaneRate(n));
                        
                        if (rawRate) {
                            // Find all other decimals in this row
                            const otherNums = nums.filter(n => n !== rawRate);
                            
                            // 2. APR: The next rate-looking number
                            const rawApr = otherNums.find(n => isSaneRate(n)) || (rawRate + 0.25);
                            
                            // 3. POINTS: Look for any number < 3.0 that is NOT the rate/APR
                            // We prioritize numbers that appeared AFTER the rate in the text
                            const rawPoints = otherNums.find(n => n >= 0 && n < 3.0 && n !== rawApr) || 0;

                            const rate = format3(rawRate);
                            const apr = format3(rawApr);
                            const points = format3(rawPoints);

                            results.push({
                                lender: lender.name, product: conf.id, date: today,
                                rate, apr, points, timestamp: admin.firestore.FieldValue.serverTimestamp()
                            });
                            console.log(`   ✅ ${conf.id}: ${rate.toFixed(3)}% | APR: ${apr.toFixed(3)}% | Pts: ${points.toFixed(3)}`);
                        }
                    }
                }
            }
        } catch (err) {
            console.error(`   ❌ ERROR: ${lender.name} - ${err.message}`);
        }
    }

    if (results.length > 0) {
        console.log(`>>> SAVING: ${results.length} items to Firebase.`);
        const batch = db.batch();
        results.forEach(res => {
            const id = `${res.date}_${res.lender}_${res.product.replace(/\s/g, '_')}`;
            batch.set(db.collection('mortgage_rates').doc(id), res);
        });
        await batch.commit();
    }
}

run();
