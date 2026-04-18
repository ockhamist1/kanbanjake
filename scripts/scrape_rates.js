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
        { name: 'PenFed', url: 'https://www.penfed.org/mortgage/mortgage-rates', render: true },
        { name: 'NFCU', url: 'https://www.navyfederal.org/loans-cards/mortgage/mortgage-rates.html', render: false },
        { name: 'Rocket', url: 'https://www.rocketmortgage.com/mortgage-rates', render: true },
        { name: 'USAA', url: 'https://www.usaa.com/banking/home-mortgages/rates/', render: false }
    ];

    for (const lender of LENDERS) {
        console.log(`>>> ATTEMPTING: ${lender.name} (Render: ${lender.render})`);
        try {
            // Reduced rendering intensity to speed up the proxy
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&premium=true&country_code=us&render=${lender.render}`;
            
            // 45-second timeout is plenty. If it takes longer, the bank is blocking us anyway.
            const response = await axios.get(proxyUrl, { timeout: 45000 });
            console.log(`   <<< RECEIVED: ${lender.name} (${response.data.length} bytes)`);

            const cleanText = response.data
                .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, '')
                .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, '')
                .replace(/<[^>]*>/g, ' | ')
                .replace(/\s+/g, ' ');

            const configs = [
                { id: '30yr Conv', keys: ['30-Year Fixed', 'Conventional'] },
                { id: '30yr VA', keys: ['VA Loan', 'Veteran'] }
            ];

            for (const conf of configs) {
                const regex = new RegExp(`(${conf.keys.join('|')})[^|]{1,1500}`, 'i');
                const match = cleanText.match(regex);

                if (match) {
                    const block = match[0];
                    const decimals = block.match(/(\d+\.\d+)/g);
                    if (decimals) {
                        const nums = decimals.map(n => parseFloat(n));
                        const rate = nums.find(n => isSaneRate(n));
                        if (rate) {
                            const apr = nums.find(n => n > rate && n < rate + 1.2) || (rate + 0.25);
                            const points = nums.find(n => n < 3.5 && n !== rate && n !== apr) || 0;
                            
                            results.push({
                                lender: lender.name, product: conf.id, date: today,
                                rate: format3(rate), apr: format3(apr), points: format3(points),
                                timestamp: admin.firestore.FieldValue.serverTimestamp()
                            });
                            console.log(`      ✅ FOUND ${conf.id}: ${rate.toFixed(3)}%`);
                        }
                    }
                }
            }
        } catch (err) {
            console.error(`   ❌ ${lender.name} FAILED: ${err.message}`);
            if (err.response && err.response.status === 403) {
                console.error("      !!! ALERT: ScraperAPI Credits potentially exhausted or IP blocked.");
            }
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
    } else {
        console.error(">>> ERROR: No rates were found across all lenders.");
    }
}

run();
