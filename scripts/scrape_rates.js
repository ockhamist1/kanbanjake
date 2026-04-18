const admin = require('firebase-admin');
const axios = require('axios');

const SCRAPER_KEY = process.env.SCRAPER_API_KEY;
const FIREBASE_KEY = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!SCRAPER_KEY || !FIREBASE_KEY) { process.exit(1); }
if (!admin.apps.length) { admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_KEY)) }); }
const db = admin.firestore();

const format3 = (val) => parseFloat(Number(val).toFixed(3));
const isSaneRate = (val) => val >= 4.5 && val <= 9.0;

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
            // Using US Proxy + Render + Premium for maximum stealth
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&render=true&premium=true&country_code=us`;
            
            const response = await axios.get(proxyUrl, { timeout: 120000 });
            let data = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

            // Strip the junk but keep pipes | to separate the table columns
            const cleanText = data
                .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, '')
                .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, '')
                .replace(/<[^>]*>/g, ' | ')
                .replace(/\s+/g, ' ');

            const configs = [
                { id: '30yr Conv', keys: ['30-Year Fixed', '30yr Fixed', 'Conventional'] },
                { id: '30yr VA', keys: ['VA Loan', 'VA Fixed', 'Veteran', 'VA 30'] }
            ];

            for (const conf of configs) {
                // Look for the product name and grab the next 1500 characters
                const regex = new RegExp(`(${conf.keys.join('|')})[^|]{1,1500}`, 'i');
                const match = cleanText.match(regex);

                if (match) {
                    const block = match[0];
                    const decimals = block.match(/(\d+\.\d+)/g);
                    
                    if (decimals && decimals.length >= 1) {
                        const nums = decimals.map(n => parseFloat(n));
                        
                        // 1. RATE: The first number in our sane range
                        const rawRate = nums.find(n => isSaneRate(n));
                        
                        if (rawRate) {
                            // 2. APR: The next rate-like number in the block
                            const rawApr = nums.find(n => isSaneRate(n) && n !== rawRate) || (rawRate + 0.25);
                            
                            // 3. POINTS: The smallest decimal in the row that isn't the Rate or APR
                            // This is what successfully found the 0.250 for NFCU!
                            const rawPoints = nums.find(n => n < 3.5 && n !== rawRate && n !== rawApr) || 0;

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
        console.log(`>>> SAVING: ${results.length} records to Firebase.`);
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
