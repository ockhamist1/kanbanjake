const admin = require('firebase-admin');
const axios = require('axios');

const SCRAPER_KEY = process.env.SCRAPER_API_KEY;
const FIREBASE_KEY = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!SCRAPER_KEY || !FIREBASE_KEY) { process.exit(1); }
if (!admin.apps.length) { admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_KEY)) }); }
const db = admin.firestore();

const format3 = (val) => parseFloat(Number(val).toFixed(3));
const isSaneRate = (val) => val >= 4.0 && val <= 9.5;

async function run() {
    const today = new Date().toISOString().split('T')[0];
    const results = [];

    const LENDERS = [
        { name: 'PenFed', url: 'https://www.penfed.org/mortgages/mortgage-rates/_jcr_content/root/container/main-container/mortgage_rate_table.model.json', type: 'json' },
        { name: 'NFCU', url: 'https://www.navyfederal.org/loans-cards/mortgage/mortgage-rates.html', type: 'html' },
        { name: 'Rocket', url: 'https://www.rocketmortgage.com/api/rates/mortgage', type: 'json' },
        { name: 'USAA', url: 'https://www.usaa.com/banking/home-mortgages/rates/', type: 'html' }
    ];

    for (const lender of LENDERS) {
        console.log(`>>> STARTING: ${lender.name}`);
        try {
            // We use a high-quality session and a fixed rendering wait
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&premium=true&country_code=us&render=${lender.type === 'html'}`;
            
            const response = await axios.get(proxyUrl, { timeout: 90000 });
            const data = response.data;
            const contentString = typeof data === 'string' ? data : JSON.stringify(data);

            const configs = [
                { id: '30yr Conv', keys: ['30-Year Fixed', '30 Year Fixed', 'Conventional'] },
                { id: '30yr VA', keys: ['VA Loan', '30-Year VA', 'Veteran'] }
            ];

            for (const conf of configs) {
                // Find a block of text around the product name
                const regex = new RegExp(`(${conf.keys.join('|')})[^}]{1,2000}`, 'i');
                const match = contentString.match(regex);

                if (match) {
                    const block = match[0];
                    // Look for decimal numbers (Rate, APR, and Points)
                    const decimals = block.match(/(\d+\.\d+)/g);
                    
                    if (decimals && decimals.length >= 1) {
                        const nums = decimals.map(n => parseFloat(n));
                        
                        // 1. RATE: The first number in our sane range
                        const rawRate = nums.find(n => isSaneRate(n));
                        
                        if (rawRate) {
                            // 2. APR: The next number in the range that isn't the rate
                            const rawApr = nums.find(n => isSaneRate(n) && n !== rawRate) || (rawRate + 0.25);
                            
                            // 3. POINTS: The first small number (< 3.0) that isn't the Rate or APR
                            // This positional logic is the most reliable way to catch points
                            const rawPoints = nums.find(n => n < 3.0 && n !== rawRate && n !== rawApr) || 0;

                            const rate = format3(rawRate);
                            const apr = format3(rawApr);
                            const points = format3(rawPoints);

                            results.push({
                                lender: lender.name, product: conf.id, date: today,
                                rate, apr, points, timestamp: admin.firestore.FieldValue.serverTimestamp()
                            });
                            console.log(`   ✅ ${lender.name} ${conf.id}: ${rate.toFixed(3)}% | Pts: ${points.toFixed(3)}`);
                        }
                    }
                }
            }
        } catch (err) {
            console.error(`   ❌ ${lender.name} FAILED: ${err.message}`);
        }
    }

    if (results.length > 0) {
        const batch = db.batch();
        results.forEach(res => {
            const id = `${res.date}_${res.lender}_${res.product.replace(/\s/g, '_')}`;
            batch.set(db.collection('mortgage_rates').doc(id), res);
        });
        await batch.commit();
        console.log(`>>> SUCCESS: Saved ${results.length} records.`);
    }
}

run();
