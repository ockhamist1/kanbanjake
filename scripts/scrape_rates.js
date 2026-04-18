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
        { name: 'PenFed', url: 'https://www.penfed.org/mortgage/mortgage-rates' },
        { name: 'NFCU', url: 'https://www.navyfederal.org/loans-cards/mortgage/mortgage-rates.html' },
        { name: 'Rocket', url: 'https://www.rocketmortgage.com/mortgage-rates' },
        { name: 'USAA', url: 'https://www.usaa.com/banking/home-mortgages/rates/' }
    ];

    const session = Math.floor(Math.random() * 99999);

    for (const lender of LENDERS) {
        console.log(`>>> GHOST FETCH: ${lender.name}`);
        try {
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&render=true&premium=true&country_code=us&session_number=${session}&device_type=desktop&keep_headers=true`;
            
            const response = await axios.get(proxyUrl, { timeout: 90000 });
            let rawData = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

            // Clean text: remove scripts/styles but keep the layout mostly flat
            const cleanText = rawData
                .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, '')
                .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, '')
                .replace(/<[^>]*>/g, ' ') 
                .replace(/\s+/g, ' ');

            const configs = [
                { id: '30yr Conv', keys: ['30-Year Fixed', '30 Year Fixed', 'Conventional'] },
                { id: '30yr VA', keys: ['30-Year VA', 'VA Loan', 'Veteran', 'VA Fixed'] }
            ];

            for (const conf of configs) {
                // Look for keywords and grab the next 1000 characters (ignoring cell boundaries)
                const regex = new RegExp(`(${conf.keys.join('|')})(.{1,1000})`, 'i');
                const match = cleanText.match(regex);

                if (match) {
                    const block = match[2];
                    // Look for all numbers (integers or decimals)
                    const decimals = block.match(/(\d+(?:\.\d+)?)/g);
                    
                    if (decimals) {
                        const nums = decimals.map(n => parseFloat(n));
                        // Find the interest rate first
                        const rate = nums.find(n => isSaneRate(n));
                        
                        if (rate) {
                            // APR: The next rate-like number in the block
                            const apr = nums.find(n => isSaneRate(n) && n !== rate) || (rate + 0.21);
                            
                            // Points: The smallest decimal in the block (usually < 3.0)
                            const points = nums.find(n => n > 0 && n < 3.5 && n !== rate && n !== apr) || 0;
                            
                            results.push({
                                lender: lender.name, product: conf.id, date: today,
                                rate: format3(rate), apr: format3(apr), points: format3(points),
                                timestamp: admin.firestore.FieldValue.serverTimestamp()
                            });
                            console.log(`      ✅ FOUND ${lender.name} ${conf.id}: ${rate.toFixed(3)}% | Pts: ${points.toFixed(3)}`);
                        }
                    }
                }
            }
            await new Promise(resolve => setTimeout(resolve, 3000));

        } catch (err) {
            console.error(`   ❌ ${lender.name} FAILED: ${err.message}`);
        }
    }

    if (results.length > 0) {
        console.log(`>>> SAVING: ${results.length} records to Firestore.`);
        const batch = db.batch();
        results.forEach(res => {
            const id = `${res.date}_${res.lender}_${res.product.replace(/\s/g, '_')}`;
            batch.set(db.collection('mortgage_rates').doc(id), res);
        });
        await batch.commit();
        console.log(">>> UPDATE COMPLETE.");
    } else {
        console.log(">>> No rates found in the data received.");
    }
}

run();
