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

    // Create a unique session ID for this entire run
    const session = Math.floor(Math.random() * 99999);

    for (const lender of LENDERS) {
        console.log(`>>> GHOST FETCH: ${lender.name}`);
        try {
            // Added device_type=desktop and keep_headers=true for maximum stealth
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&render=true&premium=true&country_code=us&session_number=${session}&device_type=desktop&keep_headers=true`;
            
            const response = await axios.get(proxyUrl, { timeout: 90000 });
            console.log(`   <<< DATA RECEIVED: ${lender.name} (${response.data.length} bytes)`);

            let cleanText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            cleanText = cleanText
                .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, '')
                .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, '')
                .replace(/<[^>]*>/g, ' | ')
                .replace(/\s+/g, ' ');

            const configs = [
                { id: '30yr Conv', keys: ['30-Year Fixed', '30 Year Fixed', 'Conventional'] },
                { id: '30yr VA', keys: ['30-Year VA', 'VA Loan', 'Veteran', 'VA Fixed'] }
            ];

            for (const conf of configs) {
                const regex = new RegExp(`(${conf.keys.join('|')})[^|]{1,2000}`, 'i');
                const match = cleanText.match(regex);

                if (match) {
                    const block = match[0];
                    const decimals = block.match(/(\d+(?:\.\d+)?)/g);
                    
                    if (decimals) {
                        const nums = decimals.map(n => parseFloat(n));
                        const rate = nums.find(n => isSaneRate(n));
                        
                        if (rate) {
                            const apr = nums.find(n => n > rate && n < rate + 1.2) || (rate + 0.25);
                            const points = nums.find(n => n > 0 && n < 3.5 && n !== rate && n !== apr) || 0;
                            
                            results.push({
                                lender: lender.name, product: conf.id, date: today,
                                rate: format3(rate), apr: format3(apr), points: format3(points),
                                timestamp: admin.firestore.FieldValue.serverTimestamp()
                            });
                            console.log(`      ✅ FOUND ${lender.name} ${conf.id}: ${rate.toFixed(3)}% (Pts: ${points.toFixed(3)})`);
                        }
                    }
                }
            }
            // Small human-like pause between lenders
            await new Promise(resolve => setTimeout(resolve, 5000));

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
    }
}

run();
